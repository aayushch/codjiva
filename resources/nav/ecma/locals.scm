(arrow_function parameter: (identifier) @local)
(variable_declarator name: (identifier) @local)
(shorthand_property_identifier_pattern) @local
(pair_pattern value: (identifier) @local)
(pair_pattern value: (assignment_pattern left: (identifier) @local))
(array_pattern (identifier) @local)
(array_pattern (assignment_pattern left: (identifier) @local))
(rest_pattern (identifier) @local)
(catch_clause parameter: (identifier) @local)
(for_in_statement left: (identifier) @local)
(function_declaration name: (identifier) @local.outer)
(generator_function_declaration name: (identifier) @local.outer)
(function_expression name: (identifier) @local)
(class_declaration name: (_) @local)

(variable_declarator
  name: (identifier) @local
  value: (new_expression constructor: (identifier) @local.type))
