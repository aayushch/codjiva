## The map view: a folder or a codebase, level by level

Show how the code of the folder is organised and how its parts use each other. The viewer sees one level at a
time and goes into a box to see what is inside it, down to single functions.

The subject is a folder. Read every code file listed in the task.

1. **Levels.** The top level holds the 2 to 8 largest parts: the programs, the packages or modules, the
   services, and the external things the code talks to (a database, a queue, a file, another system). Inside a
   package are its files or its sub-packages. Inside a file are the functions, classes or types that matter.
   At most 4 levels.
2. **At most 12 nodes in one parent.** When a level would hold more, group related nodes under a node of
   their own, named for what they have in common. A file with 30 functions shows the 8 to 12 that carry its
   behaviour, and says in `model.json → omitted` what it left out.
3. **`path`.** Give every node that stands for a file or a folder its workspace path. The app uses it to open
   the file and to list the visuals, films and other views that exist for it. This is how the map connects
   everything else that was made of this code.
4. **`role`** is one sentence on what the part is responsible for. For a function, `refs` with `line` and
   `end`.
5. **Links** say that one part uses another. Give them between the **most specific** nodes you know: function
   to function, not package to package. The runtime shows a link on every level, between the two boxes that
   contain its ends, so a call from one function to another also appears as an arrow between their files and
   between their packages. `kind` is `calls`, `imports`, `data` (one writes what the other reads) or `events`.
6. **Edge cases** of a part: a package that reaches into another's internals, a cycle between two parts, a
   file that everything depends on, an entry point that bypasses the usual path.
