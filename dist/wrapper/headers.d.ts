import { IDictionary } from "common-types";
export declare const CORS_HEADERS: {
    "Access-Control-Allow-Origin": string;
    "Access-Control-Allow-Credentials": boolean;
};
export declare function getContentType(): string;
export declare function setContentType(type: string): void;
export declare function getHeaders(): IDictionary<string>;
export declare function setHeaders(headers: IDictionary<string>): void;