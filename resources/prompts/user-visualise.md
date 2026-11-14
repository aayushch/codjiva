Visualise this code as a still, interactive blueprint.

Subject: {{subject}}
{{#folderFiles}}
The subject is a whole folder. Its code files are:
{{folderFiles}}

Read all of them. Draw one plant that shows how these files work together:
- Follow the main unit of work from where it enters the folder's code to where it leaves or ends.
- Give each file, or each closely related group of files, one machine or one small group of parts, named after
  what it does. Do not draw the inside of every function.
- Show what passes between the files: which calls which, what data moves, and where limits and errors sit.
- Every node's `refs` name the file and the line where that part lives, so a click leads to the right file.
- In model.json, set `subject` to the folder path and list the files you used under `companions` with one line
  each on what the file is responsible for.
{{/folderFiles}}
{{#companions}}Also read: {{companions}}
{{/companions}}{{#instructions}}
Instructions from the user for this visual:
"""
{{instructions}}
"""
{{/instructions}}{{^instructions}}
The user gave no special instructions. Show the two or three aspects that most change how the code behaves, and
say which you chose in model.json → focusChosen.
{{/instructions}}
Write the analysis to {{artifactDir}}/model.json and the sources to {{srcDir}}/ (plant.js and visual.json).
Report progress in {{artifactDir}}/progress.json.
Schemas: {{schemasDir}}/. A finished example to learn the method from (read-only): {{referenceDir}}/.
{{#previous}}
An earlier version of this visual is at {{previous}}. The code may have changed since it was made. Reuse its
plant and layout where they still fit, and keep node ids stable.
{{/previous}}
