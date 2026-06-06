// Registers jest-dom matchers (toBeInTheDocument, toBeDisabled, …) with Vitest's
// expect. The `/vitest` entry (not bare `/jest-dom`) wires the matcher types and
// runtime to Vitest specifically (E8).
import "@testing-library/jest-dom/vitest";

// Testing Library's automatic per-test cleanup only self-registers when Vitest
// `globals` is enabled. We keep globals off (E9 — existing lib tests import from
// "vitest" explicitly), so register cleanup ourselves to unmount between tests.
// In the node-environment unit tests nothing is ever mounted, so this is a no-op.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
