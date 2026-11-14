The user looked at the artifact in {{artifactDir}} and said:

"""
{{feedback}}
"""
{{#time}}
They were at {{time}} seconds of real time{{#chapter}}, in chapter "{{chapter}}"{{/chapter}}{{#sceneTime}}, which is animation second {{sceneTime}} of scene `{{scene}}`{{/sceneTime}}.
{{/time}}{{#pointAt}}
They pointed at this element:
{{pointAt}}
{{/pointAt}}{{#selected}}
The part selected in the visual was: {{selected}}
{{/selected}}{{#screenshot}}
A screenshot of what they saw is at {{screenshot}}. Look at it before you change anything.
{{/screenshot}}
The files in {{artifactDir}} are a copy of the version they looked at. Change only what the feedback is about,
in {{srcDir}}/ and, if the feedback corrects a fact, in {{artifactDir}}/model.json.

- Short feedback such as "this", "too fast" or "overlaps" refers to that moment and that element.
- Feedback about pace changes the `animLength`, the bubble times or the camera move durations of that chapter
  only.
- After the change, recompute the boxes of everything within 200 px and make sure nothing is crowded.

When you are done, write {"phase": "done", "note": "<one line per change, with the file name>"} to
{{artifactDir}}/progress.json.
