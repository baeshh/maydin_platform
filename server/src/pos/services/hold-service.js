const { getAll, getOne } = require('../../db');

function heldCount(pharmacyId) {
  return getOne("SELECT COUNT(*) AS count FROM pos_holds WHERE pharmacy_id = @pharmacy_id AND status = 'HELD'", {
    pharmacy_id: pharmacyId
  }).count;
}

function serializeHold(row) {
  return { ...row, items: JSON.parse(row.items_json || '[]'), items_json: undefined };
}

function holdRows(pharmacyId) {
  return getAll(
    `SELECT h.*, c.name AS customer_name, u.name AS created_by_name, o.order_number AS counsel_order_number
     FROM pos_holds h
     LEFT JOIN customers c ON c.id = h.customer_id
     LEFT JOIN users u ON u.id = h.created_by
     LEFT JOIN orders o ON o.id = h.counsel_order_id
     WHERE h.pharmacy_id = @pharmacy_id AND h.status = 'HELD'
     ORDER BY h.id ASC`,
    { pharmacy_id: pharmacyId }
  ).map(serializeHold);
}

module.exports = {
  heldCount,
  serializeHold,
  holdRows
};
