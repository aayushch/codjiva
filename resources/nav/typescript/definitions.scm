(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(enum_body (property_identifier) @name @definition.enumerator)
(enum_assignment name: (property_identifier) @name) @definition.enumerator
(internal_module name: (identifier) @name) @definition.namespace
(module name: (identifier) @name) @definition.namespace

(public_field_definition name: (property_identifier) @name) @definition.field
(public_field_definition name: (private_property_identifier) @name) @definition.field
(property_signature name: (property_identifier) @name) @definition.field
(method_signature name: (property_identifier) @name) @definition.method
(abstract_method_signature name: (property_identifier) @name) @definition.method
(function_signature name: (identifier) @name) @definition.function

(public_field_definition
  name: (_) @name
  value: (new_expression constructor: (identifier) @name.type)) @definition.field

(class_declaration
  name: (type_identifier) @name
  (class_heritage (extends_clause value: (_) @base)))
(class_declaration
  name: (type_identifier) @name
  (class_heritage (implements_clause (_) @base)))
(abstract_class_declaration
  name: (type_identifier) @name
  (class_heritage (extends_clause value: (_) @base)))
(abstract_class_declaration
  name: (type_identifier) @name
  (class_heritage (implements_clause (_) @base)))
(interface_declaration
  name: (type_identifier) @name
  (extends_type_clause type: (_) @base))
