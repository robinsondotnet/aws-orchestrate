export declare class UnhandledError extends Error {
    static apiGatewayError(errorCode: number, e: Error, requestId: string, classification?: string): string;
    static lambdaError(errorCode: number, e: Error, classification?: string): void;
    name: string;
    code: string;
    httpStatus: number;
    requestId: string;
    constructor(errorCode: number, e: Error, classification?: string);
}