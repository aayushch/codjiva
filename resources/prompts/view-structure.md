## The structure view: a data structure in memory, step by step

Show what a data structure looks like in memory as it is used: a tree that is inserted into and rebalanced, a
hash table that grows, a ring buffer that wraps, a heap, a cache that evicts, the slices and maps that a
service keeps. The viewer types a sequence of operations and steps through what each one does to the memory.

This view is stepped through, so besides `view.json` it needs **`{{srcDir}}/sim.js`**. Read "Step-throughs"
in the runtime API and the section "The step function" of what a step-through is: restate the code branch
for branch, with a `ref` for each, and do not tidy its behaviour. Report the phase `stepping` when you write
`sim.js`.

1. **The input** is a sequence of operations in an encoding small enough to type, which you describe in
   `stepper.input.hint`: `i5 i3 d5` for inserts and deletes, one character per event. List the encoding under
   `model.json → illustrative`.
2. **The nodes** are the operations of the code: `insert`, `rotateLeft`, `resize`, `evict`. A step's `state`
   is the id of the operation that is running. Give each operation its edge cases.
3. **`structure(m)`** returns the memory after the step as blocks. Use the block that matches how the code
   holds the data: `array` for a slice or a buffer, `list` for a linked list, `table` for a map, `tree` for a
   tree. Show every collection the operations touch, each as its own block with the code's name for it in the
   label.
4. **Tones.** Mark what the step changed as `primary` and what it only looked at as `secondary`. Use `marks`
   on an array for the indexes the code keeps: `head`, `tail`, `lo`, `mid`, `hi`.
5. **One step is one change the viewer can see**: one element written, one pointer moved, one rotation. An
   operation that does three things is three steps.
6. **Examples.** 3 to 9, from the code's tests where there are tests, with `expect`. Include the ones that
   reach the interesting states: the structure empty, full, at the point where it grows, rebalances, wraps or
   evicts.
7. **Variables** are the fields the structure keeps beside its data: a length, a capacity, a head index, a
   root pointer. **Outputs** are what a caller gets back.
