import { ErrorHandler, ServerlessError } from "./errors";
import {
  ErrorMeta,
  ErrorWithinError,
  HandledError,
  IHandlerContext,
  IOrchestrationRequestTypes,
  ISequenceTrackerStatus,
  IWrapperOptions,
  LambdaSequence,
  OrchestratedErrorForwarder,
  OrchestratedErrorHandler,
  RethrowError,
  UnhandledError,
  buildOrchestratedRequest,
  convertToApiGatewayError,
  database,
  findError,
  getLocalSecrets,
  getNewSequence,
  getResponseHeaders,
  getSecrets,
  invoke as invokeHigherOrder,
  invokeNewSequence,
  loggedMessages,
  maskLoggingForSecrets,
  registerSequence as register,
  saveSecretHeaders,
  sequenceStatus,
  setContentType,
  setFnHeaders,
} from "./private";
import {
  HttpStatusCodes,
  IAWSLambaContext,
  IApiGatewayErrorResponse,
  IApiGatewayResponse,
  IDictionary,
  isLambdaProxyRequest,
} from "common-types";
import type { IAdminConfig, IMockConfig } from "universal-fire";

import {get} from "native-dash";
import { invoke as invokeLambda } from "aws-log";
import { logger } from "aws-log";

/**
 * **wrapper**
 *
 * A higher order function which wraps a serverless _handler_-function with the aim of providing
 * a better typing, logging, and orchestration experience.
 *
 * @param req a strongly typed request object that is defined by the `<I>` generic
 * @param context the contextual props and functions which AWS provides plus additional
 * features brought in by the wrapper function
 */
export const wrapper = function<I, O>(
  fn: (req: I, context: IHandlerContext) => Promise<O>,
  options: IWrapperOptions = {}
) {
  /** this is the core Lambda event which the wrapper takes as an input */
  return async function(
    event: IOrchestrationRequestTypes<I>,
    context: IAWSLambaContext
  ): Promise<O | IApiGatewayResponse | IApiGatewayErrorResponse> {
    let result: O;
    let workflowStatus:
      | "initializing"
      | "unboxing-from-prior-function"
      | "starting-try-catch"
      | "prep-starting"
      | "running-function"
      | "function-complete"
      | "invoke-complete"
      | "invoke-started"
      | "sequence-defined"
      | "sequence-starting"
      | "sequence-started"
      | "sequence-tracker-starting"
      | "completing"
      | "returning-values";
    workflowStatus = "initializing";
    context.callbackWaitsForEmptyEventLoop = false;
    const log = logger().lambda(event, context);
    const msg = loggedMessages(log);
    const errorMeta: ErrorMeta = new ErrorMeta();

    /** the code to use for successful requests */
    let statusCode: number;
    workflowStatus = "unboxing-from-prior-function";
    const { request, sequence, apiGateway, headers } = LambdaSequence.from<I>(event);

    let handlerContext: IHandlerContext<I>;

    try {
      workflowStatus = "starting-try-catch";
      msg.start(request, headers, context, sequence, apiGateway);
      // const segment = xray.getSegment();
      // segment.addMetadata("initialized", request);
      saveSecretHeaders(headers, log);
      maskLoggingForSecrets(getLocalSecrets(), log);

      //#region PREP
      workflowStatus = "prep-starting";
      const status = sequenceStatus(log.getCorrelationId());
      const registerSequence = register(log, context);
      const invoke = invokeHigherOrder(sequence);
      const claims: IDictionary = JSON.parse(get(apiGateway, "requestContext.authorizer.customClaims", "{}"));
      handlerContext = {
        ...context,
        claims,
        log,
        correlationId: log.getCorrelationId(),
        headers,
        queryParameters: apiGateway?.queryStringParameters || {},
        setHeaders: setFnHeaders,
        setContentType,
        database: (config?: IAdminConfig | IMockConfig) => database(config),
        sequence,
        registerSequence,
        isSequence: sequence.isSequence,
        isDone: sequence.isDone,
        apiGateway,
        getSecrets,
        setSuccessCode: (code: number) => (statusCode = code),
        isApiGatewayRequest: isLambdaProxyRequest(event),
        errorMgmt: errorMeta,
        invoke,
      };
      //#endregion

      //#region CALL the HANDLER FUNCTION
      workflowStatus = "running-function";
      result = await fn(request, handlerContext);

      log.debug(`handler function returned to wrapper function`, { result });
      workflowStatus = "function-complete";
      //#endregion

      //#region SEQUENCE (next)
      if (sequence.isSequence && !sequence.isDone) {
        workflowStatus = "invoke-started";
        const [fn, requestBody] = sequence.next<O>(result);
        msg.startingInvocation(fn, requestBody);
        const invokeParams = await invokeLambda(fn, requestBody);
        msg.completingInvocation(fn, invokeParams);
        workflowStatus = "invoke-complete";
      } else {
        msg.notPartOfExistingSequence();
      }
      //#endregion

      //#region SEQUENCE (orchestration starting)
      if (getNewSequence().isSequence) {
        workflowStatus = "sequence-starting";
        msg.sequenceStarting();
        const seqResponse = await invokeNewSequence(result);
        msg.sequenceStarted(seqResponse);
        workflowStatus = "sequence-started";
      } else {
        msg.notPartOfNewSequence();
      }
      //#endregion

      //#region SEQUENCE (send to tracker)
      if (options.sequenceTracker && sequence.isSequence) {
        workflowStatus = "sequence-tracker-starting";
        msg.sequenceTracker(options.sequenceTracker, workflowStatus);
        await invokeLambda(options.sequenceTracker, buildOrchestratedRequest<ISequenceTrackerStatus>(status(sequence)));
        if (sequence.isDone) {
          msg.sequenceTrackerComplete(true);
        } else {
          msg.sequenceTrackerComplete(false);
        }
      }
      //#endregion

      //#region RETURN-VALUES
      workflowStatus = "returning-values";
      if (handlerContext.isApiGatewayRequest) {
        const response: IApiGatewayResponse = {
          statusCode: statusCode ? statusCode : result ? HttpStatusCodes.Success : HttpStatusCodes.NoContent,
          headers: getResponseHeaders(),
          body: result ? (typeof result === "string" ? result : JSON.stringify(result)) : "",
        };
        msg.returnToApiGateway(result, getResponseHeaders());
        log.debug("the response will be", response);
        return response;
      } else {
        log.debug(`Returning results to non-API Gateway caller`, { result });
        return result;
      }
      //#endregion
    } catch (e) {
      //#region ERROR-HANDLING
      // wrap all error handling in it's own try-catch
      try {
        const isApiGatewayRequest: boolean = isLambdaProxyRequest(apiGateway);
        msg.processingError(e, workflowStatus, isApiGatewayRequest);

        /**
         * "found" is either handler author using the `HandledError` class themselves
         * or using the API exposed at `context.errorMgmt`
         **/
        const found: ServerlessError | ErrorHandler | false =
          e instanceof ServerlessError ? e : findError(e, errorMeta);
        if (found instanceof ServerlessError) {
          found.functionName = context.functionName;
          found.classification = found.classification.replace("aws-orchestrate/", `${found.functionName}/`);
          found.correlationId = handlerContext.correlationId;
          found.awsRequestId = handlerContext.awsRequestId;

          throw found;
        }

        if (found) {
          if (!found.handling) {
            const err = new HandledError(found.code, e, log.getContext());
            if (isApiGatewayRequest) {
              return convertToApiGatewayError(err);
            } else {
              throw err;
            }
          }
          if (found.handling && found.handling.callback) {
            const resolvedLocally = found.handling.callback(e);
            if (!resolvedLocally) {
              // Unresolved Known Error!
              if (isApiGatewayRequest) {
                return convertToApiGatewayError(new HandledError(found.code, e, log.getContext()));
              } else {
                throw new HandledError(found.code, e, log.getContext());
              }
            } else {
              // Known Error was resolved
              log.info(`There was an error which was resolved by a locally defined error handler`, { error: e });
            }
          }

          if (found.handling && found.handling.forwardTo) {
            log.info(`Forwarding error to the function "${found.handling.forwardTo}"`, {
              error: e,
              forwardTo: found.handling.forwardTo,
            });
            await invokeLambda(found.handling.forwardTo, e);
          }
        } else {
          //#region UNFOUND ERROR
          log.debug(`An error is being processed by the default handling mechanism`, {
            defaultHandling: get(errorMeta, "defaultHandling"),
            errorMessage: get(e, "message", "no error messsage"),
            stack: get(e, "stack", "no stack available"),
          });
          //#endregion

          const handling = errorMeta.defaultHandling;
          switch (handling.type) {
            case "handler-fn":
              //#region handle-fn
              /**
               * results are broadly three things:
               *
               * 1. handler throws an error
               * 2. handler returns `true` which means that result should be considered successful
               * 3. handler returns _falsy_ which means that the default error should be thrown
               */
              try {
                const passed = handling.defaultHandlerFn(e);
                if (passed === true) {
                  log.debug(
                    `The error was fully handled by this function's handling function/callback; resulting in a successful condition [ ${
                      result ? HttpStatusCodes.Accepted : HttpStatusCodes.NoContent
                    } ].`
                  );
                  if (isApiGatewayRequest) {
                    return {
                      statusCode: result ? HttpStatusCodes.Accepted : HttpStatusCodes.NoContent,
                      headers: getResponseHeaders(),
                      body: result ? JSON.stringify(result) : "",
                    };
                  } else {
                    return result;
                  }
                } else {
                  log.debug(
                    `The error was passed to the callback/handler function but it did NOT resolve the error condition.`
                  );
                }
              } catch (e2) {
                // handler threw an error
                if (isApiGatewayRequest) {
                  return convertToApiGatewayError(new UnhandledError(errorMeta.defaultErrorCode, e));
                } else {
                  throw new UnhandledError(errorMeta.defaultErrorCode, e);
                }
              }
              break;
            //#endregion

            case "error-forwarding":
              //#region error-forwarding
              log.debug("The error will be forwarded to another function for handling", { arn: handling.arn });
              await invokeLambda(handling.arn, e);
              break;
            //#endregion

            case "default-error":
              //#region default-error
              /**
               * This handles situations where the user stated that if an
               * "unknown" error occurred that _this_ error should be thrown
               * in it's place.
               */
              handling.error.message = handling.error.message || e.message;
              handling.error.stack = e.stack;
              handling.error.type = "default-error";
              if (isApiGatewayRequest) {
                return convertToApiGatewayError(handling.error);
              } else {
                throw handling.error;
              }
              break;
            //#endregion

            case "default":
              //#region default
              // log.debug(`Error handled by default policy`, {
              //   code: errorMeta.defaultErrorCode,
              //   message: e.message,
              //   stack: e.stack
              // });
              log.info(`the default error code is ${errorMeta.defaultErrorCode}`);
              log.warn(
                `the error response will look like:`,
                convertToApiGatewayError(new UnhandledError(errorMeta.defaultErrorCode, e))
              );

              if (isApiGatewayRequest) {
                return convertToApiGatewayError(new UnhandledError(errorMeta.defaultErrorCode, e));
              } else {
                throw new UnhandledError(errorMeta.defaultErrorCode, e);
              }
              break;
            //#endregion

            default:
              log.debug("Unknown handling technique for unhandled error", {
                type: (handling as any).type,
                errorMessage: e.message,
              });
              throw new UnhandledError(errorMeta.defaultErrorCode, e);
          }
        }
      } catch (errorOfError) {
        /**
         * All errors end up here and it is the location where conductor-based
         * error handling can get involved in the error processing flow
         */

        if (errorOfError instanceof ServerlessError) {
          throw errorOfError;
        }

        const conductorErrorHandler: OrchestratedErrorHandler | false =
          sequence.activeFn && sequence.activeFn.onError && typeof sequence.activeFn.onError === "function"
            ? (sequence.activeFn.onError as OrchestratedErrorHandler)
            : false;
        const resolvedByConductor = async () => (conductorErrorHandler ? conductorErrorHandler(e) : false);

        const forwardedByConductor: OrchestratedErrorForwarder | false =
          sequence.activeFn && sequence.activeFn.onError && Array.isArray(sequence.activeFn.onError)
            ? (sequence.activeFn.onError as OrchestratedErrorForwarder)
            : false;

        if (forwardedByConductor) {
          await invokeLambda(...forwardedByConductor);
        } else {
          // Catch errors in error handlers
          if (
            errorOfError.type === "unhandled-error" ||
            errorOfError.type === "handled-error" ||
            errorOfError.type === "default-error"
          ) {
            throw new RethrowError(errorOfError);
          }
          throw new ErrorWithinError(e, errorOfError);
        }
      }
    }
  };
  //#endregion
};
