// {{title}} — a tool of this application's AI (AI Enablement). It calls a function the application already has,
// reached through `host` (the object the integration passes as createAiAgent({ host })). Never re-implement the
// application's logic here; drive its real controls (setControlValue from the runtime) when the logic lives in a UI
// handler. Unit-test it with `host` mocked.

export default {
  name: '{{name}}',
  title: '{{title}}',
  description: '{{description}}',
  effect: '{{effect}}',                   // read | write | destructive | external | system — when unsure, the stronger
  // pages: ['orders'],                   // where it can be used (omit: everywhere)
  parameters: {
    // query: { type: 'string', required: true, maxLength: 200, description: 'What to look for.' },
  },
  run: (args, { host }) => {
    // TODO: call the application's own function, e.g. `return host.orders.find(args.query);`
    throw new Error('{{name}} is not implemented yet.');
  },
};
