// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExportButton } from "./ExportButton";

describe("ExportButton", () => {
  beforeEach(() => {
    // jsdom implements neither object-URL API.
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an object URL and downloads as a sanitized .yaml file on click", () => {
    let downloadName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloadName = this.download;
      },
    );

    render(<ExportButton yaml="title: 红楼梦\n" title={'红/楼:梦'} />);
    fireEvent.click(screen.getByRole("button"));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloadName).toBe("红_楼_梦.yaml");
  });
});
