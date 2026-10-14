import { RequestBuilder } from "./RequestBuilder";

export function MainPane() {
  return (
    <main id="main" class="main" aria-label="Request builder and journey">
      <RequestBuilder />
      <div class="empty">
        <b>Journey canvas and details</b>
        Journey lands in D6, details in D7.
      </div>
    </main>
  );
}
