import { HttpStatusCodes } from "common-types";
import get from "lodash.get";
/**
 * Rethrows an error which has a `code` property set
 * such as `HandledError` or `HandledError`; preserving
 * _code_, _name_, _httpStatus_, and _stack_.
 */
export class RethrowError extends Error {
    constructor(err) {
        super(err.message);
        this.code = get(err, "code");
        this.name = get(err, "name");
        this.stack = get(err, "stack");
        this.type = get(err, "type");
        this.httpStatus = get(err, "httpStatus", HttpStatusCodes.InternalServerError);
    }
}
//# sourceMappingURL=RethrowError.js.map