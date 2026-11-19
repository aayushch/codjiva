(call_expression function: (identifier) @call)
(call_expression function: (field_expression field: (field_identifier) @call))
(field_expression argument: (_) @qualifier field: (field_identifier) @member)
(field_designator (field_identifier) @member)
(type_identifier) @type
