# Model providers

The person's model providers are what their chats can run on, the same ones
the web app's Model providers page shows. Only the person's own chats and
their assistant manage them; an Issue's sessions and verifiers do not.

- `list_model_providers` shows them by kind: `subscription` (the official
  Claude or ChatGPT login on each device), `api` (an Anthropic- or
  OpenAI-compatible endpoint stored on the server and assigned to devices),
  `environment` (a launch environment a connector gives a device; it is
  managed in Connectors) and `discovered` (an endpoint found in a device's
  own configuration). Its first page lists the person's devices too.
- `save_model_provider` adds an API endpoint (`runtime` claude for
  Anthropic-compatible, codex for OpenAI-compatible, `label`, `baseUrl`) or
  changes one by `providerId`. `deviceIds` is the whole set of devices that
  run it; a new endpoint runs nowhere until you give it devices. `model` and
  `effort` are its defaults on every device.
- `set_model_defaults` sets a subscription's or environment's default model
  and effort on one device.
- `delete_model_provider` removes an API endpoint and its stored key. Say
  what will stop working and confirm with the person first.

## Keys

- A key the person gives you goes only into `apiKey` of
  `save_model_provider`. Never repeat it in your reply, a file, a command
  line or a message to another session. Answers show only `keySet`.
- If the person has not given a key and the endpoint needs one, ask for it;
  never look for one on the device.

## Checks use quota

`check_model_provider` on an API endpoint or environment runs one short
conversation through that device's own Claude Code or Codex, which spends a
little of the provider's quota: say so before you run it. On a subscription
it only reads the device's login. Foundry never calls a model endpoint
itself, and neither do you: no curl to `/v1/messages`, `/responses` or
`/chat/completions` to test a provider.

## Signing a device in

`sign_in_subscription` with action `start` makes the device's own CLI begin
its sign-in and answers a link (and, for ChatGPT, a code). Give the person the
link to open in their own browser; never open or approve it yourself. For
Claude, when `codeEntry` is true, the person pastes the code the page shows
after approval: send it with action `code`. Follow with action `status` until
it is `complete`; signing out stays on the web app.
