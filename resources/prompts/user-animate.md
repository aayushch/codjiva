Animate this code as a film of about {{length}} seconds.

Subject: {{subject}}
{{#companions}}Companions (read these too): {{companions}}
{{/companions}}{{#instructions}}
Instructions from the user for this film:
"""
{{instructions}}
"""
{{/instructions}}{{^instructions}}
The user gave no special instructions. Follow one unit of work through the two or three aspects that most
change how the code behaves, and say which you chose in model.json → focusChosen.
{{/instructions}}
Write the analysis to {{artifactDir}}/model.json, then {{artifactDir}}/outline.json straight away, then the
sources to {{srcDir}}/ (plant.js, film.json and scenes/<id>.js). Report progress in {{artifactDir}}/progress.json.
Schemas: {{schemasDir}}/. A finished film to learn the method from (read-only): {{referenceDir}}/film/.
{{#outline}}
The user has approved this outline. It is already saved as {{artifactDir}}/outline.json. Follow it exactly: the
same chapters, in the same order, with the same titles.
"""
{{outline}}
"""
{{/outline}}{{#visual}}
A still visual of this subject exists at {{visual}}. Start from its src/plant.js and its model.json: keep the
layout, the part names and the node ids, and add what the film needs.
{{/visual}}{{#previous}}
An earlier version of this film is at {{previous}}. The code may have changed since it was made. Reuse its
plant and scenes where they still fit.
{{/previous}}
