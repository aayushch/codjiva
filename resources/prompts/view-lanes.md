## The lanes view: who talks to whom, in time order

Show an exchange between several parties as it unfolds: a request through a set of services, a call through a
set of components, two threads that share a lock, a frontend component with its store and the server.

1. **The participants** are the nodes, 2 to 8, in the order they first take part, left to right. A participant
   is something that can be waiting while another one works: a client, a service, a function that others call,
   a thread or goroutine, a queue, a store, a component, an external system. Do not make a participant of every
   function: a function that only its own caller uses belongs in a `does` line of a step.
2. **Scenarios.** The first is the usual run from start to end. Then add one for **each way the exchange can
   go differently**: every error that is handled, every timeout, every retry, every rejected request, every
   branch that changes who is called. A viewer chooses a scenario and plays it, so each must stand on its own
   and start from the beginning of the exchange, or from the event that sets it off.
3. **Steps** are the messages, in the order they happen. One step for a call, one for its return when the
   return carries something the next step depends on. `from` and `to` the same for work that a participant does
   by itself and that matters to the story.
   - `label` is what is sent, as the code writes it: `Submit(order)`, `VerdictAllow`, `error`.
   - `kind`: `call` for a call that waits, `async` for one that does not, `event` for something published,
     `return`, and `error`, `timeout` or `retry` where the code handles those.
   - `note` is one sentence on what this step means. `does` lists what the receiver does because of it, in the
     code's own names. `ref` is the line of the call.
4. **Concurrency.** When two participants run at the same time, order the steps as one possible run, and say
   in the `note` of the step where it matters what else could have happened first. Make a scenario of an
   ordering that the code guards against, such as two writers and one lock.
5. **Edge cases** of a participant: a lock held across a slow call, an error that is dropped, a retry without a
   limit, a message that can arrive twice.

Keep a scenario under 30 steps. A longer exchange is two scenarios.
