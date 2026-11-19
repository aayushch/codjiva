(parameter_declaration type: (_) @local.type declarator: (identifier) @local)
(parameter_declaration
  type: (_) @local.type
  declarator: (pointer_declarator declarator: (identifier) @local))
(parameter_declaration
  type: (_) @local.type
  declarator: (pointer_declarator
    declarator: (pointer_declarator declarator: (identifier) @local)))
(parameter_declaration
  type: (_) @local.type
  declarator: (array_declarator declarator: (identifier) @local))

(declaration type: (_) @local.type declarator: (identifier) @local)
(declaration
  type: (_) @local.type
  declarator: (init_declarator declarator: (identifier) @local))
(declaration
  type: (_) @local.type
  declarator: (pointer_declarator declarator: (identifier) @local))
(declaration
  type: (_) @local.type
  declarator: (init_declarator
    declarator: (pointer_declarator declarator: (identifier) @local)))
(declaration
  type: (_) @local.type
  declarator: (array_declarator declarator: (identifier) @local))
(declaration
  type: (_) @local.type
  declarator: (init_declarator
    declarator: (array_declarator declarator: (identifier) @local)))

; A variable built with arguments, as in `FileSink sink(path);`, reads like the
; prototype of a function. Inside a function body it is a local variable.
(declaration
  type: (_) @local.type
  declarator: (function_declarator declarator: (identifier) @local))
