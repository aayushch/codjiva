(parameter_declaration
  type: (_) @local.type
  declarator: (reference_declarator (identifier) @local))
(optional_parameter_declaration type: (_) @local.type declarator: (identifier) @local)
(optional_parameter_declaration
  type: (_) @local.type
  declarator: (reference_declarator (identifier) @local))
(optional_parameter_declaration
  type: (_) @local.type
  declarator: (pointer_declarator declarator: (identifier) @local))

(declaration
  type: (_) @local.type
  declarator: (reference_declarator (identifier) @local))
(declaration
  type: (_) @local.type
  declarator: (init_declarator
    declarator: (reference_declarator (identifier) @local)))

(for_range_loop type: (_) @local.type declarator: (identifier) @local)
(for_range_loop
  type: (_) @local.type
  declarator: (reference_declarator (identifier) @local))
(structured_binding_declarator (identifier) @local)
