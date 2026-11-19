(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (_) @name) @definition.class

(method_definition name: (property_identifier) @name) @definition.method
(method_definition name: (private_property_identifier) @name) @definition.method

(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function
(variable_declarator name: (identifier) @name) @definition.variable
(variable_declarator
  name: (object_pattern
    [
      (shorthand_property_identifier_pattern) @name
      (pair_pattern value: (identifier) @name)
      (object_assignment_pattern left: (shorthand_property_identifier_pattern) @name)
    ])) @definition.variable
(variable_declarator name: (array_pattern (identifier) @name)) @definition.variable

(pair
  key: (property_identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.method

(assignment_expression
  left: (member_expression object: (this) property: (property_identifier) @name)) @definition.field

(variable_declarator
  name: (identifier) @name
  value: (new_expression constructor: (identifier) @name.type)) @definition.variable
