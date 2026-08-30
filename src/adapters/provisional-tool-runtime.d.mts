export const REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME: "register_provisional_case_adapter";
export const REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_CONTRACT: Readonly<{
  contractVersion: "1.0.0";
  name: typeof REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME;
  title: string;
  description: string;
  effect: "write";
  approval: "required";
  timeoutMs: number;
  maxResultBytes: number;
  inputSchema: Readonly<{
    type: "object";
    properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    required: readonly string[];
    additionalProperties: false;
  }>;
}>;
export const REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH: string;
