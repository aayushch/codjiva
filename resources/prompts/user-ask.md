{{#scopeText}}
The question is about this code: `{{path}}`, lines {{scopeLines}}{{#scopeName}} ({{scopeName}}){{/scopeName}}.

````
{{scopeText}}
````
{{/scopeText}}{{^scopeText}}{{#path}}
The question is about `{{path}}`.
{{/path}}{{/scopeText}}{{#artifactDir}}
The developer has a {{artifactWord}} of this code on screen. Its files are in {{artifactDir}} (read-only):
the analysis in model.json and the sources in src/.
{{/artifactDir}}{{#parts}}
The parts of the {{artifactWord}}, as `id: name` with the place in the code where the part is:
{{parts}}
{{/parts}}{{#chapters}}
The chapters of the film, as `id: title` with the second the chapter starts at:
{{chapters}}
{{/chapters}}{{#selected}}
The part selected on screen is `{{selected}}`.
{{/selected}}{{#time}}
The film is at {{time}} seconds of real time{{#chapter}}, in chapter "{{chapter}}"{{/chapter}}.
{{/time}}{{#history}}
The discussion so far:
"""
{{history}}
"""
{{/history}}
The question:
"""
{{question}}
"""
