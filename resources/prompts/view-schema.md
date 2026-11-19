## The schema view: the data shapes of the code

Show every data shape that the subject defines or passes around: structs, classes, records, interfaces,
enums, database tables, messages, transfer objects. One node per type.

1. **Every field, in the order of the code**, with its type as the code writes it. Mark with `key: true` the
   fields that identify a record, and with `optional: true` the ones that may be absent or null. An enum's
   values are its fields, without a type.
2. **A type that the subject only uses** is a node too when the viewer needs it to read a field's type: the
   interface a field holds, the enum a field takes its value from. Give such a node its real fields. Leave out
   types of the language and its standard library.
3. **Relations.** One for every field that holds or refers to another type of the view, with `field` naming
   that field. `has` when it contains the other (a struct in a struct, a slice of structs), `refers` when it
   holds an id, a pointer or an interface value, `extends` and `implements` for inheritance.
4. **Uses: who reads and who writes each field.** This is the part a reader cannot get from the type alone.
   For every field, list each function that **writes** it, with the line of the assignment. List a function
   that **reads** it when the read decides something: a branch, a limit, a routing choice. A field with no
   writer in the code you read is worth an edge case that says so.
5. **Edge cases** of a type: a field that is overwritten whatever the caller passed, a field that is never cleared, a
   collection that only grows, two fields that must change together but are written in different places, a
   default that means something special.

A schema of one file usually has 4 to 14 types.
