#include "synctex_parser.h"
#include <emscripten.h>

static synctex_scanner_p scanner;
static double result[11];

EMSCRIPTEN_KEEPALIVE void close_index(void) {
    if (scanner) synctex_scanner_free(scanner);
    scanner = NULL;
}

EMSCRIPTEN_KEEPALIVE int open_index(void) {
    close_index();
    scanner = synctex_scanner_new_with_output_file("/document.pdf", NULL, 1);
    return scanner != NULL;
}

EMSCRIPTEN_KEEPALIVE synctex_node_p first_input(void) { return synctex_scanner_input(scanner); }
EMSCRIPTEN_KEEPALIVE synctex_node_p next_input(synctex_node_p input) { return synctex_node_sibling(input); }
EMSCRIPTEN_KEEPALIVE int input_tag(synctex_node_p input) { return synctex_node_tag(input); }
EMSCRIPTEN_KEEPALIVE const char *input_name(int tag) { return synctex_scanner_get_name(scanner, tag); }

static double *next_result(void) {
    synctex_node_p node = synctex_scanner_next_result(scanner);
    if (!node) return NULL;
    result[0] = synctex_node_tag(node);
    result[1] = synctex_node_line(node);
    result[2] = synctex_node_column(node);
    result[3] = synctex_node_page(node);
    result[4] = synctex_node_visible_h(node);
    result[5] = synctex_node_visible_v(node);
    result[6] = synctex_node_box_visible_h(node);
    result[7] = synctex_node_box_visible_v(node);
    result[8] = synctex_node_box_visible_width(node);
    result[9] = synctex_node_box_visible_height(node);
    result[10] = synctex_node_box_visible_depth(node);
    return result;
}

EMSCRIPTEN_KEEPALIVE double *forward(int tag, int line, int column, int page) {
    if (!scanner || synctex_display_query(scanner, input_name(tag), line, column, page) <= 0) return NULL;
    return next_result();
}

EMSCRIPTEN_KEEPALIVE double *inverse(int page, float x, float y) {
    if (!scanner || synctex_edit_query(scanner, page, x, y) <= 0) return NULL;
    return next_result();
}

EMSCRIPTEN_KEEPALIVE double *more_results(void) { return next_result(); }
