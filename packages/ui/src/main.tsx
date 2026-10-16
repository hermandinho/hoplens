import { render } from "preact";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/layout.css";
import "./styles/overview.css";
import "./styles/request.css";
import "./styles/canvas.css";
import "./styles/log.css";

const target = document.getElementById("app");
if (target) render(<App />, target);
