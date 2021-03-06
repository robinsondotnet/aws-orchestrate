import {
  IAWSLambdaProxyIntegrationRequest,
  IDictionary,
  arn,
  getBodyFromPossibleLambdaProxyRequest,
  isLambdaProxyRequest,
} from "common-types";
import {
  IFanOutResponse,
  IFanOutTuple,
  ILambaSequenceFromResponse,
  ILambdaFunctionType,
  ILambdaSequenceNextTuple,
  ILambdaSequenceStep,
  IOrchestratedDynamicProperty,
  IOrchestratedProperties,
  IOrchestratedRequest,
  IOrchestrationRequestTypes,
  ISerializedSequence,
  IWrapperRequestHeaders,
  OrchestratedCondition,
  OrchestratedErrorHandler,
  decompress,
  isBareRequest,
  isDynamic,
  isOrchestratedRequest,
} from "./private";
import { buildOrchestratedRequest } from "./sequences/index";
import { invoke as invokeLambda, logger } from "aws-log";

import { get } from "native-dash";

export class LambdaSequence {
  /**
   * **add** (static initializer)
   *
   * Instantiates a `LambdaSequence` object and then adds a task to the sequence
   */
  public static add<T extends IDictionary = IDictionary>(
    arn: string,
    params: Partial<IOrchestratedProperties<T>> = {},
    type: ILambdaFunctionType = "task"
  ) {
    const obj = new LambdaSequence();
    obj.add(arn, params, type);
    return obj;
  }

  /**
   * **from**
   *
   * Allows you to take the event payload which your handler gets from Lambda
   * and return a hash/dictionary with the following properties:
   *
   * - the `request` (core event without "sequence" meta or LamdaProxy info
   * from API Gateway)
   * - the `sequence` as an instantiated class of **LambdaSequence**
   * - the `apiGateway` will have the information from the Lambda Proxy request
   * (only if request came from API Gateway)
   * - the `headers` will be filled with a dictionary of name/value pairs regardless
   * of whether the request came from API Gateway (equivalent to `apiGateway.headers`)
   * or from another function which was invoked as part of s `LambdaSequence`
   *
   * Example Code:
   *
```typescript
export function handler(event, context, callback) {
  const { request, sequence, apiGateway } = LambdaSequence.from(event);
  // ... do some stuff ...
  await sequence.next()
}
```
   * **Note:** if you are using the `wrapper` function then the primary use of this
   * function will have already been done for you by the _wrapper_.
   */
  public static from<T extends IDictionary = IDictionary>(
    event: IOrchestrationRequestTypes<T>,
    logger?: import("aws-log").ILoggerApi
  ) {
    const obj = new LambdaSequence();

    return obj.from(event, logger);
  }

  /**
   * Takes a serialized sequence and brings it back to a `LambdaSequence` class.
   */
  public static deserialize<T>(s: ISerializedSequence): LambdaSequence {
    const obj = new LambdaSequence();
    obj.deserialize(s);

    return obj;
  }

  /**
   * instantiate a sequence with no steps;
   * this is considered a _non_-sequence (aka.,
   * it is `LambdaSequence` class but until it
   * has steps it's role is simply to state that
   * it is NOT a sequence)
   */
  public static notASequence() {
    const obj = new LambdaSequence();
    obj._steps = [];
    return obj;
  }

  /**
   * The steps defined in the sequence
   */
  private _steps: ILambdaSequenceStep[] = [];
  /**
   * The responses from completed functions in a sequence
   */
  private _responses: IDictionary = {};

  /**
   * **add**
   *
   * adds another task to the sequence
   *
   * @param arn the function name; it can be a full AWS arn or a shortened version with just the function name (assuming appropriate ENV variables are set)
   * @param params any parameters for the downstream function in the sequence which are known at build time
   * @param type not critical but provides useful context about the function of the function being added to the sequence
   *
   * **Note:** to use the shortened **arn** you will need to ensure the function has
   * the following defined as ENV variables:
   *
   * - `AWS_STAGE`
   * - `AWS_ACCOUNT_ID`
   * - `AWS_REGION`
   *
   * These should relatively static and therefore should be placed in your `env.yml` file if
   * you're using the Serverless framework.
   */
  public add<T extends IDictionary = IDictionary>(
    arn: string,
    params: Partial<IOrchestratedProperties<T>> = {},
    type: ILambdaFunctionType = "task"
  ) {
    this._steps.push({ arn, params, type, status: "assigned" });
    return this;
  }

  /**
   * Passes execution to an AWS handler function when an error condition is encountered
   * in the prior Task step. This function will be treated as being a part of the sequence
   * but it will become the last step in the sequence as the remaining steps (if they exist)
   * will _not_ be executed.
   *
   * @param arn the AWS ARN identifier for the function; this _can_ be a shortened name if
   * the appropriate ENV variables are set
   *
   * @param params the handler will always get an `error` property forwarded onto the function
   * but you may state additional parameters you want to pass to the downstream handler function
   */
  public onError<T extends IDictionary = IDictionary>(
    arn: arn,
    params?: Partial<IOrchestratedProperties<T>>
  ): Promise<false>;
  /**
   * Run a local -- _local to the erroring serverless function_ -- handler function to determine whether the
   * sequence should continue.
   *
   * @param handler the handler function
   */
  public onError<T extends Error = Error>(handler: OrchestratedErrorHandler): Promise<boolean>;
  /**
   * Assigns error handling to last added **Task** in the sequence
   */
  public onError<T>(...args: any[]): Promise<boolean> {
    //
    return;
  }

  /**
   * Adds a Task to the sequence who's execution is conditional on the evaluation
   * of a supplied function (which is run directly prior to invocation if you're
   * using the `wrapper` function for your **handler**).
   *
   * @param fn the conditional evaluation function
   * @param arn the AWS ARN for the function to call (conditionally); you may use shortcut ARN
   * names so long as you've set the proper ENV variables.
   * @param params the _static_ or _dynamic_ values you want passed to this function
   */
  public onCondition<T extends IDictionary = IDictionary>(
    fn: OrchestratedCondition,
    arn: arn,
    params: Partial<IOrchestratedProperties<T>>
  ) {
    this._steps.push({
      arn,
      params,
      onCondition: fn,
      type: "task",
      status: "assigned",
    });
  }

  /**
   * Fans the sequence out to parallel tracks of execution. Each
   * tuple in the array represents a different function and parameter stack.
   *
   * @param tuples an array of tuples, each in the format of `[arn: string, params: T}]`
   *
   * **Note:** each downstream execution will be passed the same `X-Correlation-Id` to keep
   * the ability to see the full set of functions from it's origin. It will also send all
   * functions the `X-Fan-Out: true` header which will ensure that each function will establish
   * a `X-Child-CorrelationId` which will be unique to that child's execution but will be
   * propagated forward if that function is part of a sequence.
   */
  public fanOut<T = IDictionary>(...tuples: Array<IFanOutTuple<T>>): IFanOutResponse<T>;
  /**
   * Fans the sequence out to parallel tracks of execution. Each instance
   * of execution is sent to the _same_ serverless handler but the parameters passed in
   * will be (or at least _can be_ different for each).
   *
   * @param arn the arn which is being called multiple times in parallel
   * @param instanceParams the parameters to pass each execution of the function (which is
   * defined by `arn`)
   *
   * **Note:** each downstream execution will be passed the same `X-Correlation-Id` to keep
   * the ability to see the full set of functions from it's origin. It will also send all
   * functions the `X-Fan-Out: true` header which will ensure that each function will establish
   * a `X-Child-CorrelationId` which will be unique to that child's execution but will be
   * propagated forward if that function is part of a sequence.
   */
  public fanOut<T = IDictionary>(arn: string, instanceParams: T[]): IFanOutResponse<T>;
  public fanOut<T>(...args: any[]): IFanOutResponse<T> {
    throw new Error("the fanOut functionality is not yet available");
  }

  /**
   * **next**
   *
   * Returns the parameters needed to execute the _invoke()_ function. There
   * are two parameters: `fnArn` and `requestBody`. The first parameter is simply a string
   * representing the fully-qualified AWS **arn** for the function. The `requestBody` is
   * structured like so:
   *
   * ```typescript
   * { body, headers, sequence }
   * ```
   *
   * This structure allows the receiving `LambdaSequence.from()` function to peel
   * off _headers_ and _sequence_ information without any risk of namespace collisions
   * with the returned request object (aka, `body`).
   */
  public next<T extends IDictionary>(
    /** the _current_ function's response */
    currentFnResponse: Partial<T> = {}
  ): ILambdaSequenceNextTuple<T> {
    this.finishStep(currentFnResponse);

    return this.getInvocationParameters<T>();
  }

  private getInvocationParameters<T extends IDictionary>() {
    /**
     * Because `activeFn` has been moved forward to the "next function"
     * using the `activeFn` reference is correct
     **/
    let body: T = this.resolveRequestProperties<T>(this.activeFn);
    let arn = this.activeFn.arn;
    this.validateCallDepth();
    const request = buildOrchestratedRequest<T>(body, this);

    return [arn, request] as ILambdaSequenceNextTuple<T>;
  }

  /**
   * Invokes the first function in a new sequence.
   */
  public start<T extends IDictionary = IDictionary>() {
    return invokeLambda(...this.getInvocationParameters<T>());
  }

  /**
   * Ensures that you can't call yourself in a sequence unless this has been
   * enabled explicitly.
   */
  private validateCallDepth() {
    // TODO: implement
  }

  /**
   * **from**
   *
   * unboxes `request`, `sequence`, `apiGateway`, and `headers` data structures
   */
  public from<T>(
    event: IOrchestrationRequestTypes<T>,
    // TODO: remove this from API in future
    logger?: import("aws-log").ILoggerApi
  ): ILambaSequenceFromResponse<T> {
    let apiGateway: IAWSLambdaProxyIntegrationRequest | undefined;
    let headers: IWrapperRequestHeaders = {};
    let sequence: LambdaSequence;
    let request: T;

    if (isLambdaProxyRequest(event)) {
      apiGateway = { ...{}, ...event };
      headers = apiGateway.headers;
      delete apiGateway.headers;
      request = getBodyFromPossibleLambdaProxyRequest<T>(event) as T;
      sequence = LambdaSequence.notASequence();
      delete apiGateway.body;
    } else if (isOrchestratedRequest(event)) {
      headers = decompress((event as IOrchestratedRequest<T>).headers);
      request = decompress(event.body);
      sequence = LambdaSequence.deserialize<T>(decompress(event.sequence));
    } else if (isBareRequest(event)) {
      headers = {};
      sequence =
        typeof event === "object" && event._sequence
          ? this.ingestSteps(event, event._sequence)
          : LambdaSequence.notASequence();
      request =
        typeof event === "object" && event._sequence
          ? (Object.keys(event).reduce((props: T, prop: keyof T & string) => {
              if (prop !== "_sequence") {
                props[prop] = event[prop];
              }
              return props;
            }, {}) as T)
          : event;
    }

    // The active function's output is sent into the params
    const activeFn = this.activeFn && this.activeFn.params ? this.activeFn.params : {};
    request =
      typeof request === "object"
        ? ({ ...activeFn, ...request } as T)
        : // TODO: This may have to deal with the case where request type is a non-object but there ARE props from `activeFn` which are needed
          request;

    return {
      request: request as T,
      apiGateway,
      sequence,
      headers: headers as IWrapperRequestHeaders,
    };
  }

  /**
   * boolean flag which indicates whether the current execution of the function
   * is part of a _sequence_.
   */
  public get isSequence() {
    return this._steps && this._steps.length > 0;
  }

  public get isDone() {
    return !this.nextFn;
  }

  /**
   * the tasks in the sequence that still remain in the
   * "assigned" category. This excludes those which are
   * completed _and_ any which are _active_.
   */
  public get remaining() {
    return this._steps ? this._steps.filter((s) => s.status === "assigned") : [];
  }

  /** the tasks which have been completed */
  public get completed() {
    return this._steps ? this._steps.filter((s) => s.status === "completed") : [];
  }

  /** the total number of _steps_ in the sequence */
  public get length() {
    return this._steps.length;
  }

  /**
   * **steps**
   *
   * returns the list of steps which have been accumulated
   * so far
   */
  public get steps() {
    return this._steps;
  }

  public get nextFn() {
    return this.remaining.length > 0 ? this.remaining[0] : undefined;
  }

  /**
   * Sets the currently _active_ function to `completed` and registers
   * the active functions results into the `_responses` dictionary.
   *
   * @param results the results from the activeFn's execution
   */
  public finishStep(results: any) {
    this._responses[this.activeFn.arn] = results;
    this.activeFn.status = "completed";
  }

  public get activeFn(): ILambdaSequenceStep {
    if (!this._steps.length) {
      return;
    }
    const log = logger().reloadContext();
    const active = this._steps ? this._steps.filter((s) => s.status === "active") : [];

    if (active.length > 1) {
      log.warn(`There appears to be more than 1 STEP in the sequence marked as active!`, { steps: this._steps });
    }

    if (active.length === 0) {
      const step = this._steps.find((i) => i.status === "assigned");
      if (!step) {
        throw new Error(
          `Problem resolving activeFn: no step with status "assigned" found. \n\n ${JSON.stringify(this._steps)}`
        );
      }
      step.status = "active";
      return this.activeFn;
    }

    return active[0];
  }

  /**
   * Ingests a set of steps into the current sequence; resolving
   * dynamic properties into real values at the same time.
   *
   * **Note:** if this sequence _already_ has steps it will throw
   * an error.
   *
   * **Note:** you can pass in either a serialized string or the actual
   * array of steps.
   */
  public ingestSteps(request: any, steps: string | ILambdaSequenceStep[]) {
    if (typeof steps === "string") {
      steps = JSON.parse(steps) as ILambdaSequenceStep[];
    }

    if (this._steps.length > 0) {
      throw new Error(`Attempt to ingest steps into a LambdaSequence that already has steps!`);
    }

    this._steps = steps;
    const activeFnParams = this.activeFn && this.activeFn.params ? this.activeFn.params : {};
    const transformedRequest =
      typeof request === "object" ? { ...activeFnParams, ...request } : { ...activeFnParams, request };

    /**
     * Inject the prior function's request params into
     * active functions params (set in the conductor)
     */
    this._steps = this._steps.map((s) => {
      return this.activeFn && s.arn === this.activeFn.arn ? { ...s, params: transformedRequest } : s;
    });

    return this;
  }

  /**
   * **dynamicProperties**
   *
   * if the _value_ of a parameter passed to a function leads with the `:`
   * character this is an indicator that it is a "dynamic property" and
   * it's true value should be looked up from the sequence results.
   */
  public get dynamicProperties(): Array<{ key: string; from: string }> {
    return Object.keys(this.activeFn ? this.activeFn.params : {}).reduce((prev, key) => {
      const currentValue = this.activeFn.params[key];
      const valueIsDynamic = String(currentValue).slice(0, 1) === ":";

      return valueIsDynamic ? prev.concat({ key, from: currentValue.slice(1) }) : prev;
    }, []);
  }

  /**
   * Takes a serialized state of a sequence and returns
   * a `LambdaSequence` which represents this state.
   */
  public deserialize(s: ISerializedSequence) {
    if (!s.isSequence) {
      return LambdaSequence.notASequence();
    }

    this._steps = s.steps;
    this._responses = s.responses;

    return this;
  }

  public toString() {
    return JSON.stringify(this.toObject(), null, 2);
  }
  public toObject(): ISerializedSequence {
    const obj: Partial<ISerializedSequence> = {
      isSequence: this.isSequence,
    };
    if (obj.isSequence) {
      obj.totalSteps = this.steps.length;
      obj.completedSteps = this.completed.length;

      if (this.activeFn) {
        obj.activeFn = this.activeFn.arn;
      }
      if (this.completed) {
        obj.completed = this.completed.map((i) => i.arn);
      }
      if (this.remaining) {
        obj.remaining = this.remaining.map((i) => i.arn);
      }
      obj.steps = this._steps;
      obj.responses = this._responses || {};
    }
    return obj as ISerializedSequence;
  }
  public toJSON() {
    return this.toObject();
  }

  /**
   * Determine the request data to pass to the handler function:
   *
   * - Resolve _dynamic_ properties added by Conductor into static values
   * - Add _static_ properties passed in from Conductor
   *
   */
  private resolveRequestProperties<T>(fn: ILambdaSequenceStep) {
    return Object.keys(fn.params as IOrchestratedProperties<T>).reduce((props: T, key: keyof T & string) => {
      let value = (fn.params as IOrchestratedProperties<T>)[key];
      if (isDynamic(value)) {
        value = get(this._responses, (value as IOrchestratedDynamicProperty).lookup, undefined);

        if (typeof value === undefined) {
          throw new Error(
            `The property "${key}" was set as a dynamic property by the Orchestrator but it was dependant on getting a value from ${
              (fn.params as IOrchestratedProperties<T>)[key]
            } which could not be found.`
          );
        }
      }
      const valueNow = (key: keyof T & string, value: any) => value as T[typeof key];

      (props as T)[key] = valueNow(key, value);

      return props;
    }, {} as T);
  }
}
