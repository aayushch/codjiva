Make the {{view}} view of this code. The runtime draws it from the data you write.

Subject: {{subject}}
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
