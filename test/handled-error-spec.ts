import { IAWSLambaContext, IAWSLambdaProxyIntegrationRequest } from "common-types";
import { IHandlerContext, IHandlerFunction, ServerlessError, wrapper } from "../src/index";

import { expect } from "chai";

const CORRELATION_ID = "c-123";
const AWS_REQUEST_ID = "1234";
const FUNCTION_NAME = "myHandlerFunction";
const ERROR_CODE = 403;

describe("Handling errors => ", () => {
  it("throwing a ServerlessError is passed through by the wrapper function", async () => {
    let foo: number = 0;
    const myHandler: IHandlerFunction<void, void> = async (req, ctx) => {
      foo = 1;
      throw new ServerlessError(ERROR_CODE, "a test of an explicit error throw", "testing");
    };
    try {
      const wrapped = wrapper(myHandler);
      const result = await wrapped(
        { headers: { "X-Correlation-Id": CORRELATION_ID } } as IAWSLambdaProxyIntegrationRequest,
        {
          awsRequestId: AWS_REQUEST_ID,
          functionName: FUNCTION_NAME,
        } as IAWSLambaContext
      );
    } catch (e) {
      expect(e.name).to.equal("ServerlessError");
      expect(e.httpStatus).to.equal(ERROR_CODE);
      expect(e.correlationId).to.equal(CORRELATION_ID);
      expect(e.awsRequestId).to.equal(AWS_REQUEST_ID);
    }
  });
});