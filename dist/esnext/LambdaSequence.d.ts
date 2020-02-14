import { IDictionary, arn } from "common-types";
import { ILambdaFunctionType, ILambdaSequenceStep, ILambdaSequenceNextTuple, ILambaSequenceFromResponse, ISerializedSequence, IOrchestratedProperties, IOrchestrationRequestTypes, IFanOutTuple, IFanOutResponse, OrchestratedErrorHandler, OrchestratedCondition } from "./@types";
export declare class LambdaSequence {
    /**
     * **add** (static initializer)
     *
     * Instantiates a `LambdaSequence` object and then adds a task to the sequence
     */
    static add<T extends IDictionary = IDictionary>(arn: string, params?: Partial<IOrchestratedProperties<T>>, type?: ILambdaFunctionType): LambdaSequence;
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
    static from<T extends IDictionary = IDictionary>(event: IOrchestrationRequestTypes<T>, logger?: import("aws-log").ILoggerApi): ILambaSequenceFromResponse<T>;
    /**
     * Takes a serialized sequence and brings it back to a `LambdaSequence` class.
     */
    static deserialize<T>(s: ISerializedSequence): LambdaSequence;
    /**
     * instantiate a sequence with no steps;
     * this is considered a _non_-sequence (aka.,
     * it is `LambdaSequence` class but until it
     * has steps it's role is simply to state that
     * it is NOT a sequence)
     */
    static notASequence(): LambdaSequence;
    /**
     * The steps defined in the sequence
     */
    private _steps;
    /**
     * The responses from completed functions in a sequence
     */
    private _responses;
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
    add<T extends IDictionary = IDictionary>(arn: string, params?: Partial<IOrchestratedProperties<T>>, type?: ILambdaFunctionType): this;
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
    onError<T extends IDictionary = IDictionary>(arn: arn, params?: Partial<IOrchestratedProperties<T>>): Promise<false>;
    /**
     * Run a local -- _local to the erroring serverless function_ -- handler function to determine whether the
     * sequence should continue.
     *
     * @param handler the handler function
     */
    onError<T extends Error = Error>(handler: OrchestratedErrorHandler): Promise<boolean>;
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
    onCondition<T extends IDictionary = IDictionary>(fn: OrchestratedCondition, arn: arn, params: Partial<IOrchestratedProperties<T>>): void;
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
    fanOut<T = IDictionary>(...tuples: Array<IFanOutTuple<T>>): IFanOutResponse<T>;
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
    fanOut<T = IDictionary>(arn: string, instanceParams: T[]): IFanOutResponse<T>;
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
    next<T extends IDictionary>(
    /** the _current_ function's response */
    currentFnResponse?: Partial<T>): ILambdaSequenceNextTuple<T>;
    private getInvocationParameters;
    /**
     * Invokes the first function in a new sequence.
     */
    start<T extends IDictionary = IDictionary>(): Promise<import("aws-sdk/clients/lambda").InvocationResponse>;
    /**
     * Ensures that you can't call yourself in a sequence unless this has been
     * enabled explicitly.
     */
    private validateCallDepth;
    /**
     * **from**
     *
     * unboxes `request`, `sequence`, `apiGateway`, and `headers` data structures
     */
    from<T>(event: IOrchestrationRequestTypes<T>, logger?: import("aws-log").ILoggerApi): ILambaSequenceFromResponse<T>;
    /**
     * boolean flag which indicates whether the current execution of the function
     * is part of a _sequence_.
     */
    get isSequence(): boolean;
    get isDone(): boolean;
    /**
     * the tasks in the sequence that still remain in the
     * "assigned" category. This excludes those which are
     * completed _and_ any which are _active_.
     */
    get remaining(): ILambdaSequenceStep<IDictionary<any>>[];
    /** the tasks which have been completed */
    get completed(): ILambdaSequenceStep<IDictionary<any>>[];
    /** the total number of _steps_ in the sequence */
    get length(): number;
    /**
     * **steps**
     *
     * returns the list of steps which have been accumulated
     * so far
     */
    get steps(): ILambdaSequenceStep<IDictionary<any>>[];
    get nextFn(): ILambdaSequenceStep<IDictionary<any>>;
    /**
     * Sets the currently _active_ function to `completed` and registers
     * the active functions results into the `_responses` dictionary.
     *
     * @param results the results from the activeFn's execution
     */
    finishStep(results: any): void;
    get activeFn(): ILambdaSequenceStep;
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
    ingestSteps(request: any, steps: string | ILambdaSequenceStep[]): this;
    /**
     * **dynamicProperties**
     *
     * if the _value_ of a parameter passed to a function leads with the `:`
     * character this is an indicator that it is a "dynamic property" and
     * it's true value should be looked up from the sequence results.
     */
    get dynamicProperties(): Array<{
        key: string;
        from: string;
    }>;
    /**
     * Takes a serialized state of a sequence and returns
     * a `LambdaSequence` which represents this state.
     */
    deserialize(s: ISerializedSequence): LambdaSequence;
    toString(): string;
    toObject(): ISerializedSequence;
    toJSON(): ISerializedSequence;
    /**
     * Determine the request data to pass to the handler function:
     *
     * - Resolve _dynamic_ properties added by Conductor into static values
     * - Add _static_ properties passed in from Conductor
     *
     */
    private resolveRequestProperties;
}