// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InputPanel, MAX_NOVEL_CHARS } from "./InputPanel";

const MANIFEST = {
  samples: [
    { id: "honglou", genre: "古典章回", title: "《红楼梦》前三回", blurb: "旁白与视角切换" },
    { id: "webnovel", genre: "现代网文", title: "《回响纪元》开篇", blurb: "系统提示与心理活动" },
  ],
};

/** fetch mock: manifest for `/api/sample`, text for `/api/sample?id=...`. */
function fakeFetch(textById: Record<string, string> = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("?id=")) {
      const id = new URL(url, "http://x").searchParams.get("id") ?? "";
      return new Response(textById[id] ?? `正文-${id}`, { status: 200 });
    }
    return new Response(JSON.stringify(MANIFEST), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

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
    render(<Controlled fetchImpl={fakeFetch()} />);
    const convert = screen.getByRole("button", { name: "转换" });
    expect(convert).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "第一回 ……" },
    });
    expect(convert).toBeEnabled();
  });

  it("renders a card per sample from the manifest", async () => {
    render(<Controlled fetchImpl={fakeFetch()} />);
    expect(await screen.findByText("《红楼梦》前三回")).toBeInTheDocument();
    expect(screen.getByText("《回响纪元》开篇")).toBeInTheDocument();
    expect(screen.getByText("古典章回")).toBeInTheDocument();
  });

  it("loads a sample by id into the textarea when its card is clicked", async () => {
    const fetchImpl = fakeFetch({ webnovel: "回响纪元正文" });
    render(<Controlled fetchImpl={fetchImpl} />);

    fireEvent.click(await screen.findByText("《回响纪元》开篇"));

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("回响纪元正文"),
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/sample?id=webnovel");
  });

  it("concatenates multiple uploaded files in natural filename order", async () => {
    render(<Controlled fetchImpl={fakeFetch()} />);
    const file2 = new File(["二章"], "第10章.txt", { type: "text/plain" });
    const file1 = new File(["一章"], "第2章.txt", { type: "text/plain" });

    // hidden input is the only file input on the panel
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file2, file1] } });

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("一章\n\n二章"),
    );
  });

  it("calls onConvert when 转换 is clicked with text present", () => {
    const onConvert = vi.fn();
    render(<Controlled fetchImpl={fakeFetch()} onConvert={onConvert} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "正文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "转换" }));
    expect(onConvert).toHaveBeenCalledTimes(1);
  });

  it("disables 转换 when text exceeds the character limit", () => {
    render(<Controlled fetchImpl={fakeFetch()} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "a".repeat(MAX_NOVEL_CHARS + 1) },
    });
    expect(screen.getByRole("button", { name: "转换" })).toBeDisabled();
  });
});
