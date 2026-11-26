Make the {{view}} view of this code. The runtime draws it from the data you write.

Subject: {{subject}}
{{#scopeLines}}
Draw only a part of that file: lines {{scopeLines}}{{#scopeName}}, the definition `{{scopeName}}`{{/scopeName}}.
The user selected this code and wants to understand it. Read the rest of the file, and other files where a
call leads there, only to understand what enters and leaves these lines. Give the code outside these lines no
parts of its own: show it, where it matters, as what the selected code receives from or hands on to. Every
`refs` entry of a node names lines inside the selection.
{{/scopeLines}}
{{#folderFiles}}
The subject is a whole folder. Its code files are:
{{folderFiles}}

Read all of them.
{{/folderFiles}}
{{#companions}}Also read: {{companions}}
{{/companions}}{{#instructions}}
Instructions from the user for this view:
"""
{{instructions}}
"""
{{/instructions}}{{^instructions}}
The user gave no special instructions. Be complete, and say in model.json → focusChosen what you gave the most
room to.
{{/instructions}}
Write the analysis to {{artifactDir}}/model.json and the view to {{srcDir}}/view.json. Report progress in
{{artifactDir}}/progress.json.
Schemas: {{schemasDir}}/ (view-{{view}}.schema.json). A finished {{view}} view to learn the method from
(read-only): {{referenceDir}}/views/{{view}}/.
{{#previous}}
An earlier version of this view is at {{previous}}. The code may have changed since it was made. Reuse what
still fits, and keep node ids stable.
{{/previous}}
