import { createRoot } from "react-dom/client";
import { AgentQuestionCard } from "../src/components/conversation/agent-question-card";
import "../src/styles.css";
import "./markdown-gallery.css";

// The agent question card in its states; ?theme=dark|light.
const questions = [
  {
    title: "How many flavors should we launch?",
    options: ["Three (core line)", "Five (full case)", "Just one hero"],
  },
  { title: "Anything we should avoid?" },
];
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "dark" ? "dark" : "light";

createRoot(document.getElementById("root")!).render(
  <main
    className="markdown-gallery"
    style={{ display: "grid", gap: 20, width: 640 }}
  >
    {(["waiting", "answered", "assumed"] as const).map((state) => (
      <AgentQuestionCard
        active={false}
        answers={["Three (core line)", "Nothing"]}
        itemId={`q-${state}`}
        key={state}
        onAnswer={async () => undefined}
        questions={questions}
        state={state}
      />
    ))}
  </main>,
);
