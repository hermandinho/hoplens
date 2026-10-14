import { Journey } from "./Journey";
import { RequestBuilder } from "./RequestBuilder";

export function MainPane() {
  return (
    <main id="main" class="main" aria-label="Request builder and journey">
      <RequestBuilder />
      <Journey />
    </main>
  );
}
