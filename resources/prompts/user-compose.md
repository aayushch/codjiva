Compose these artifacts into one pipeline {{form}}.

Parts, in flow order:
{{parts}}

Joins the user confirmed:
{{joins}}
{{#instructions}}
Instructions from the user for this pipeline:
"""
{{instructions}}
"""
{{/instructions}}
Write the analysis to {{artifactDir}}/model.json and the sources to {{srcDir}}/. The parts' plants are already
in {{srcDir}}/parts/ and {{srcDir}}/pipeline.json is already written. Report progress in
{{artifactDir}}/progress.json.
Schemas: {{schemasDir}}/. A finished small pipeline to learn the method from (read-only): {{referenceDir}}/pipeline/.
{{#previous}}
An earlier version of this pipeline is at {{previous}}. Reuse its yard where it still fits.
{{/previous}}
