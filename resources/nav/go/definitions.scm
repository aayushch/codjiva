(function_declaration name: (identifier) @name) @definition.function

(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: [
        (type_identifier) @parent
        (pointer_type (type_identifier) @parent)
        (generic_type type: (type_identifier) @parent)
        (pointer_type (generic_type type: (type_identifier) @parent))
      ]))
  name: (field_identifier) @name) @definition.method

(type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(type_spec name: (type_identifier) @name) @definition.type
(type_alias name: (type_identifier) @name) @definition.type

(const_spec name: (identifier) @name) @definition.constant
(var_spec name: (identifier) @name) @definition.variable

(field_declaration name: (field_identifier) @name) @definition.field
(method_elem name: (field_identifier) @name) @definition.method

(type_spec
  name: (type_identifier) @name
  type: (struct_type
    (field_declaration_list (field_declaration !name type: (_) @base))))
