/**
 * Home — a thin server shell that renders the client `ConverterApp`. All
 * interactivity (streaming, state, exports) lives inside the client boundary;
 * this page stays a server component (E10).
 */

import { ConverterApp } from "./components/ConverterApp";

export default function Home() {
  return (
    <main className="min-h-full bg-zinc-50 dark:bg-black">
      <ConverterApp />
    </main>
  );
}
