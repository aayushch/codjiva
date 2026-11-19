(call_expression function: (qualified_identifier name: (identifier) @call))
(call_expression function: (template_function name: (identifier) @call))
(qualified_identifier scope: (_) @qualifier name: (identifier) @member)
(qualified_identifier scope: (_) @qualifier name: (type_identifier) @member)
(field_initializer (field_identifier) @member)
(namespace_identifier) @type
