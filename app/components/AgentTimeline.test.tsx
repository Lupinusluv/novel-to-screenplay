// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentTimeline } from "./AgentTimeline";
import { initialPipelineState, type PipelineState } from "../../lib/client/pipelineState";

describe("AgentTimeline", () => {
  it("renders the four crew stages with their role labels", () => {
    render(<AgentTimeline state={initialPipelineState()} />);
    expect(screen.getByText(/场记/)).toBeInTheDocument();
    expect(screen.getByText(/设定集/)).toBeInTheDocument();
    expect(screen.getByText(/场景编剧/)).toBeInTheDocument();
    expect(screen.getByText(/导演/)).toBeInTheDocument();
  });

  it("lights the scenes stage active and shows done/total progress", () => {
    const state: PipelineState = {
      ...initialPipelineState(),
      status: "running",
      stages: {
        chunk: { status: "done" },
        storybible: { status: "done" },
        scenes: { status: "active", done: 3, total: 9 },
        assemble: { status: "pending" },
      },
    };
    render(<AgentTimeline state={state} />);

    const scenesRow = screen.getByText(/场景编剧/).closest("li");
    expect(scenesRow).not.toBeNull();
    expect(scenesRow).toHaveTextContent("进行中");
    expect(scenesRow).toHaveTextContent("3 / 9");
  });
});
