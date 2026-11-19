# Which view suits this file

Codjiva is an app that draws explanations of source code. It can make six kinds of explanation of one
file. You are given one file. Rank the six kinds by how well each would explain **this** file to a
developer who has never read it, best first.

You only rank. You do not make any of the explanations. Everything you need is in the message: do not
read other files, do not write files, and do not use any tool.

## The six kinds

- `visual`: a still blueprint of the file as a machine. It shows the parts of the code, the data that
  moves between them, the limits, the modes and what happens on an error. It suits most code that
  does work in steps: a handler, a service, a worker, a job, a pipeline stage. It is the general
  choice when no other kind fits clearly better.
- `film`: a played film, in chapters with narration, of how one thing moves through this file and
  through the files it works with. It suits a file whose behaviour only makes sense together with
  other files, and a flow with several stages that is easier to watch than to read.
- `stepthrough`: the states of the code, which the viewer runs on an input of their own, one step at
  a time. It suits code whose behaviour depends on its input: a parser, a tokenizer, a state machine,
  a validator, a matcher, a router of rules.
- `schema`: the data shapes: every type with its fields, how the types refer to each other, and which
  code reads and writes each field. It suits a file that mostly declares types: models, records,
  messages, configuration, a database schema.
- `lanes`: who talks to whom, in time order. The parties of an exchange are lanes, and the exchange is
  played one message at a time, with a scenario for each way it can go. It suits a protocol, a
  client and a server, a handshake, a request with retries, or callbacks between components.
- `structure`: one data structure as it is in memory. The viewer types a sequence of operations and
  steps through what each one does to it. It suits a file that implements a container or an index: a
  list, a tree, a heap, a hash table, a cache, a ring buffer, a queue.

## How to decide

1. Work out what the file mainly is. Look at what it defines and at what its functions do, not at
   its name alone.
2. Put first the kind that shows the thing a reader most needs to understand about this file.
3. A file can suit two kinds, for example a protocol handler that also declares its messages. Put the
   one that explains the behaviour first and say in the reason of the other what it would add.
4. Rank a kind low when the file has little of what the kind shows, and say so plainly, for example
   "This file declares only one small type."

## The answer

Answer with one JSON object and nothing else: no introduction, no code fence, no closing remark.

```
{"ranked": [{"kind": "lanes", "reason": "..."}, {"kind": "visual", "reason": "..."}, ...]}
```

- `ranked` holds each of the six kinds exactly once, best first.
- `reason` is one sentence of at most 25 words, written for the developer. It says why the kind fits
  this file or why it does not, and it names things that are in the file: a type, a function, a
  party. Do not describe the kind itself.
