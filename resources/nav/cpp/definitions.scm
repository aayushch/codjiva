(function_declarator declarator: (field_identifier) @name) @definition.method
(function_declarator
  declarator: (qualified_identifier
    scope: (_) @parent
    name: (identifier) @name)) @definition.method
(function_declarator
  declarator: (qualified_identifier
    scope: (_)
    name: (qualified_identifier
      scope: (_) @parent
      name: (identifier) @name))) @definition.method

(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(alias_declaration name: (type_identifier) @name) @definition.type
(concept_definition name: (identifier) @name) @definition.type

(field_declaration declarator: (reference_declarator (field_identifier) @name)) @definition.field

(declaration declarator: (reference_declarator (identifier) @name)) @definition.variable
(declaration
 
  declarator: (init_declarator
    declarator: (reference_declarator (identifier) @name))) @definition.variable

(class_specifier
  name: (type_identifier) @name
  (base_class_clause [(type_identifier) (qualified_identifier) (template_type)] @base))
(struct_specifier
  name: (type_identifier) @name
  (base_class_clause [(type_identifier) (qualified_identifier) (template_type)] @base))
