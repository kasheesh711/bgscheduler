import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  hmacKeyFile,
  loadHmacKey,
  loadOrCreateHmacKey,
  readProposalFiles,
  signProposal,
  verifyProposal,
  writeProposal,
} from "../proposals";
import { SID, correctionProposal as proposal } from "./nightly-fixtures";

/** Synthetic lesson text only. */
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-proposals-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function key(): Buffer {
  const loaded = loadOrCreateHmacKey(home);
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.key;
}

describe("the signing key", () => {
  it("is created once, 0600, 32 random bytes, and never overwritten", () => {
    expect(loadHmacKey(home)).toEqual({ ok: false, reason: "hmac_key_missing" });
    const first = loadOrCreateHmacKey(home);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(fs.statSync(hmacKeyFile(home)).mode & 0o777).toBe(0o600);
    const again = loadOrCreateHmacKey(home);
    expect(again).toMatchObject({ ok: true, created: false });
    expect(first.ok && again.ok && first.key.equals(again.key)).toBe(true);
    expect(first.ok && first.key.length).toBe(32);
  });

  it("is refused when another user could read it, or when it is not 32 bytes", () => {
    key();
    fs.chmodSync(hmacKeyFile(home), 0o644);
    expect(loadHmacKey(home)).toEqual({ ok: false, reason: "hmac_key_permissions" });
    fs.chmodSync(hmacKeyFile(home), 0o600);
    fs.writeFileSync(hmacKeyFile(home), "short");
    expect(loadHmacKey(home)).toEqual({ ok: false, reason: "hmac_key_length" });
  });
});

describe("signed proposals", () => {
  it("canonical JSON sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("verifies what verify signed, and refuses unsigned, tampered or foreign-signed proposals", () => {
    const signed = signProposal(proposal(), key());
    expect(verifyProposal(JSON.parse(JSON.stringify(signed)), key())).toMatchObject({ ok: true, proposal: { wiseSessionId: SID } });
    expect(verifyProposal({ proposal: proposal() }, key())).toEqual({ ok: false, reason: "unsigned" });
    expect(verifyProposal({ ...signed, signature: "00".repeat(32) }, key())).toEqual({ ok: false, reason: "signature_mismatch" });
    const edited = JSON.parse(JSON.stringify(signed));
    edited.proposal.fields.performance += " She also finished the mock paper.";
    expect(verifyProposal(edited, key())).toEqual({ ok: false, reason: "signature_mismatch" });
    const otherKey = Buffer.alloc(32, 7);
    expect(verifyProposal(signed, otherKey)).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verifyProposal(null, key())).toEqual({ ok: false, reason: "not_a_proposal" });
  });

  it("refuses a signed proposal that is not well formed", () => {
    const k = key();
    expect(verifyProposal(signProposal(proposal({ fieldsHash: "deadbeef" }), k), k)).toEqual({ ok: false, reason: "fields_hash" });
    expect(verifyProposal(signProposal(proposal({ rootCauseRef: " " }), k), k)).toEqual({ ok: false, reason: "root_cause_ref_missing" });
    expect(verifyProposal(signProposal(proposal({ reason: "" }), k), k)).toEqual({ ok: false, reason: "reason" });
    expect(verifyProposal(signProposal(proposal({ wiseSessionId: "../x" }), k), k)).toEqual({ ok: false, reason: "session_id" });
  });

  it("writes proposals/<sid>.json 0600 and reads every proposal file back", () => {
    const dir = path.join(home, "proposals");
    const file = writeProposal(dir, proposal(), key());
    expect(path.basename(file)).toBe(`${SID}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
    const files = readProposalFiles(dir);
    expect(files.map((entry) => entry.wiseSessionId)).toEqual([SID]);
    expect(verifyProposal(files[0].value, key()).ok).toBe(true);
    expect(readProposalFiles(path.join(home, "missing"))).toEqual([]);
  });
});
