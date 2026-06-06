// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InputPanel, MAX_NOVEL_CHARS } from "./InputPanel";

function Controlled({
  fetchImpl,
  onConvert = () => {},
}: {
  fetchImpl?: typeof fetch;
  onConvert?: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <InputPanel
      value={value}
      onChange={setValue}
      onConvert={onConvert}
      fetchImpl={fetchImpl}
    />
  );
}

describe("InputPanel", () => {
  it("disables 转换 while empty and enables it once there is text", () => {
    render(<Controlled />);
    const convert = screen.getByRole("button", { name: "转换" });
    expect(convert).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "第一回 ……" },
    });
    expect(convert).toBeEnabled();
  });

  it("fills the textarea from GET /api/sample when clicking the example button", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("内置红楼梦示例正文", { status: 200 }));
    render(<Controlled fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /示例/ }));

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("内置红楼梦示例正文"),
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/sample");
  });

  it("calls onConvert when 转换 is clicked with text present", () => {
    const onConvert = vi.fn();
    render(<Controlled onConvert={onConvert} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "正文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    expect(onConvert).toHaveBeenCalledTimes(1);
  });

  it("disables 转换 when text exceeds the character limit", () => {
    render(<Controlled />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "a".repeat(MAX_NOVEL_CHARS + 1) },
    });
    expect(screen.getByRole("button", { name: "转换" })).toBeDisabled();
  });
});
