import { render } from "preact";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/layout.css";

const target = document.getElementById("app");
if (target) render(<App />, target);
