import { HttpStatusCodes } from 'common-types'

/**
 * Thrown when a function calls itself more than the allowed `callDepth`
 * setting allows for.
 */
export class CallDepthExceeded extends Error {
  /**
   * creates an error to be thrown by a **Lambda** function which
   * was initiatiated by a
   */

  /**
   * The `name` is of the format `type`/`sub-type`
   */
  name: string
  /**
   * The `code` is the "sub-type" of the name
   */
  code: string

  /** the HTTP errorCode */
  httpStatus: number
  /** the AWS requestId */
  requestId: string

  originalStack: string

  constructor(callDepth: number) {
    super('')

    this.name = 'aws-orchestrate/call-depth-exceeded'
    this.code = 'call-depth-exceeded'
    this.httpStatus = HttpStatusCodes.InternalServerError
    this.message = `The allowed number of self-calls [ ] was exceeded!"`
  }
}
