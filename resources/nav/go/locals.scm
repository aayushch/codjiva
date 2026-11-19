(parameter_declaration name: (identifier) @local type: (_) @local.type)
(variadic_parameter_declaration name: (identifier) @local)
(short_var_declaration left: (expression_list (identifier) @local))
(var_spec name: (identifier) @local type: (_) @local.type)
(var_spec name: (identifier) @local)
(const_spec name: (identifier) @local)
(range_clause left: (expression_list (identifier) @local))
(receive_statement left: (expression_list (identifier) @local))
(type_switch_statement alias: (expression_list (identifier) @local))

(short_var_declaration
  left: (expression_list . (identifier) @local .)
  right: (expression_list . (composite_literal type: (_) @local.type) .))
(short_var_declaration
  left: (expression_list . (identifier) @local .)
  right: (expression_list
    . (unary_expression operand: (composite_literal type: (_) @local.type)) .))
