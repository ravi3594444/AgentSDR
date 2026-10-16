import { describe, expect, test } from "bun:test";
import {
  instagramAccountStatus,
  instagramAccountStatusFromError,
  instagramUnipileErrorType,
  instagramHostedAuthName,
  instagramUnipileErrorStatus,
  mapUnipileInstagramAccount,
  parseInstagramHostedAuthName,
  UnipileInstagramError,
} from "./unipile.instagram";

const ORG = "5f0b6a43-6f1e-4d7a-9a39-1c1d2a3b4c5d";
const USER = "0e8f3c1a-2b4d-4e6f-8a9b-0c1d2e3f4a5b";

describe("instagramAccountStatus", () => {
  test("maps Unipile's source statuses", () => {
    expect(instagramAccountStatus("OK")).toBe("connected");
    expect(instagramAccountStatus("running")).toBe("connected");
    expect(instagramAccountStatus("CONNECTING")).toBe("connected");
    expect(instagramAccountStatus("CREDENTIALS")).toBe("credentials");
    expect(instagramAccountStatus("STOPPED")).toBe("disconnected");
    expect(instagramAccountStatus("DISCONNECTED")).toBe("disconnected");
    expect(instagramAccountStatus("ERROR")).toBe("error");
    expect(instagramAccountStatus(undefined)).toBe("error");
  });
});

describe("mapUnipileInstagramAccount", () => {
  test("reads an Instagram account and nothing else", () => {
    expect(mapUnipileInstagramAccount({
      object: "Account",
      type: "INSTAGRAM",
      id: "acc_ig_1",
      name: "Baner Bakery",
      connection_params: { im: { id: "17841400000000001", username: "@banerbakery" } },
      sources: [{ id: "s", status: "OK" }],
    })).toEqual({
      unipileAccountId: "acc_ig_1",
      name: "Baner Bakery",
      username: "banerbakery",
      providerUserId: "17841400000000001",
      status: "connected",
    });
    expect(mapUnipileInstagramAccount({ type: "WHATSAPP", id: "acc_wa", sources: [{ status: "OK" }] })).toBeNull();
    expect(mapUnipileInstagramAccount({ type: "LINKEDIN", id: "acc_li" })).toBeNull();
    expect(mapUnipileInstagramAccount({ type: "INSTAGRAM" })).toBeNull();
    expect(mapUnipileInstagramAccount({ type: "INSTAGRAM", id: "acc_ig_2", sources: [{ status: "CREDENTIALS" }] })).toMatchObject({
      name: null,
      username: null,
      providerUserId: null,
      status: "credentials",
    });
  });
});

describe("hosted sign-in name", () => {
  test("carries the organization and the member who started the link", () => {
    const name = instagramHostedAuthName(ORG, USER);
    expect(name).toBe(`${ORG}:${USER}`);
    expect(parseInstagramHostedAuthName(name)).toEqual({ organizationId: ORG, userId: USER });
    expect(parseInstagramHostedAuthName(name.toUpperCase())).toEqual({ organizationId: ORG, userId: USER });
  });

  test("LinkedIn's names and junk are not Instagram owners", () => {
    expect(parseInstagramHostedAuthName("agentsdr")).toBeNull();
    expect(parseInstagramHostedAuthName("clx0abc123def456")).toBeNull();
    expect(parseInstagramHostedAuthName(`${ORG}:not-a-user`)).toBeNull();
    expect(parseInstagramHostedAuthName(`${ORG}:${USER}:extra`)).toBeNull();
    expect(parseInstagramHostedAuthName(null)).toBeNull();
  });
});

describe("instagramUnipileErrorStatus", () => {
  test("reads the status from our error, an SDK problem body, or a response", () => {
    expect(instagramUnipileErrorStatus(new UnipileInstagramError(422, "x"))).toBe(422);
    expect(instagramUnipileErrorStatus({ body: { status: 404, title: "Not found" } })).toBe(404);
    expect(instagramUnipileErrorStatus({ response: { status: 503 } })).toBe(503);
    expect(instagramUnipileErrorStatus(new Error("network"))).toBeNull();
    expect(instagramUnipileErrorStatus(null)).toBeNull();
  });
});

describe("account problems on a failed call", () => {
  test("reads Unipile's problem type from our error or an SDK problem body", () => {
    expect(instagramUnipileErrorType(new UnipileInstagramError(401, "x", "errors/disconnected_account"))).toBe("errors/disconnected_account");
    expect(instagramUnipileErrorType({ body: { status: 401, type: "errors/expired_credentials" } })).toBe("errors/expired_credentials");
    expect(instagramUnipileErrorType(new UnipileInstagramError(500, "x"))).toBeNull();
    expect(instagramUnipileErrorType(new Error("network"))).toBeNull();
  });

  test("only a disconnected account or expired credentials say the account cannot send", () => {
    expect(instagramAccountStatusFromError(new UnipileInstagramError(401, "x", "errors/disconnected_account"))).toBe("disconnected");
    expect(instagramAccountStatusFromError({ body: { type: "errors/expired_credentials" } })).toBe("credentials");
    // The recipient, the chat, rate limits, an unclear 401: the account is not marked.
    expect(instagramAccountStatusFromError(new UnipileInstagramError(422, "x", "errors/cannot_resend_yet"))).toBeNull();
    expect(instagramAccountStatusFromError(new UnipileInstagramError(429, "x", "errors/too_many_requests"))).toBeNull();
    expect(instagramAccountStatusFromError(new UnipileInstagramError(401, "x", "errors/missing_credentials"))).toBeNull();
    expect(instagramAccountStatusFromError(new UnipileInstagramError(401, "x"))).toBeNull();
  });
});
