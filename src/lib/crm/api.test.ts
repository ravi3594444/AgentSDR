import { describe, expect, test } from "bun:test";
import { crmOperationErrorResponse } from "./api";
import { DefiniteCrmSendError } from "./send";

describe("crmOperationErrorResponse", () => {
  test("a refused send says why, instead of a generic server error", async () => {
    const response = crmOperationErrorResponse(new DefiniteCrmSendError("Google Workspace is not connected — connect it in Settings → Email → Connection"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Not sent: Google Workspace is not connected — connect it in Settings → Email → Connection",
      code: "SEND_REFUSED",
    });
  });
});
