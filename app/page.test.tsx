// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "./page";

describe("Home page", () => {
  it("renders the converter app, not the create-next-app scaffold", () => {
    render(<Home />);
    expect(screen.getByText("AI 小说转剧本")).toBeInTheDocument();
    // No leftover scaffold copy.
    expect(
      screen.queryByText(/edit the page\.tsx/i),
    ).not.toBeInTheDocument();
  });
});
