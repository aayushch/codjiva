(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(union_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(type_item name: (type_identifier) @name) @definition.type
(associated_type name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.variable
(mod_item name: (identifier) @name) @definition.module
(macro_definition name: (identifier) @name) @definition.macro
(enum_variant name: (identifier) @name) @definition.enumerator
(field_declaration name: (field_identifier) @name) @definition.field

(impl_item type: (type_identifier) @name) @container
(impl_item type: (generic_type type: (type_identifier) @name)) @container
(impl_item type: (scoped_type_identifier name: (type_identifier) @name)) @container

(impl_item trait: (_) @base type: (_) @name)
(trait_item
  name: (type_identifier) @name
  bounds: (trait_bounds [(type_identifier) (scoped_type_identifier) (generic_type)] @base))
