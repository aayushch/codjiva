Make a step-through of this code: a drawing of its states that the viewer can run on an input, one step at a
time.

Subject: {{subject}}
{{#companions}}Also read: {{companions}}
{{/companions}}{{#instructions}}
Instructions from the user for this step-through:
"""
{{instructions}}
"""
{{/instructions}}{{^instructions}}
The user gave no special instructions. Choose the input that the code's behaviour depends on most, and say
which you chose in model.json → focusChosen.
{{/instructions}}
Write the analysis to {{artifactDir}}/model.json and the sources to {{srcDir}}/ (plant.js, visual.json and
sim.js). Report progress in {{artifactDir}}/progress.json.
Schemas: {{schemasDir}}/. A finished step-through to learn the method from (read-only):
{{referenceDir}}/stepthrough/.
{{#visual}}
A still visual of this subject exists at {{visual}}. Its model.json has an analysis of the same code. Start
from it, and read the code again for every branch the step function needs.
{{/visual}}{{#previous}}
An earlier version of this step-through is at {{previous}}. The code may have changed since it was made. Reuse
its drawing and its step function where they still fit, and keep node ids stable.
{{/previous}}
