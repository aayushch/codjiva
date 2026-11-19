(call_expression function: (identifier) @call)
(call_expression function: (selector_expression field: (field_identifier) @call))
(selector_expression operand: (_) @qualifier field: (field_identifier) @member)
(qualified_type package: (package_identifier) @qualifier name: (type_identifier) @member)
(keyed_element key: (literal_element (identifier) @member))
(type_identifier) @type
