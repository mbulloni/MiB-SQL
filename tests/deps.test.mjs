import test from 'node:test';
import assert from 'node:assert/strict';
import { renameColumnIn, renameColumnStatement, renameTableIn, routineCalls, tablesUsed } from '../src/deps.ts';

// SHOW CREATE VIEW on MariaDB: tables in parentheses, columns qualified by alias
const MARIA_VIEW = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_orders` AS select `o`.`id` AS `id`,`o`.`qty` AS `qty`,`c`.`name` AS `customer` from (`orders` `o` join `customers` `c` on(`o`.`customer_id` = `c`.`id`))";
// SHOW CREATE VIEW on MySQL 8: tables qualified by database
const MYSQL_VIEW = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_tot` AS select `shop`.`orders`.`customer_id` AS `customer_id`,sum(`shop`.`orders`.`qty`) AS `qty` from `shop`.`orders` group by `shop`.`orders`.`customer_id`";

test('table rename in views: MariaDB and MySQL forms', () => {
  let r = renameTableIn(MARIA_VIEW, 'shop', { db: 'shop', table: 'orders' }, 'sales');
  assert.equal(r.changes, 1);
  assert.match(r.text, /from \(`sales` `o` join `customers` `c`/);
  assert.match(r.text, /`o`\.`qty`/); // alias references untouched
  assert.deepEqual(r.warnings, []);
  r = renameTableIn(MYSQL_VIEW, 'shop', { db: 'shop', table: 'orders' }, 'sales');
  assert.equal(r.changes, 4);
  assert.ok(!/`orders`/.test(r.text));
  assert.match(r.text, /`shop`\.`sales`\.`qty`/);
  // a view of another database reading shop.orders, and one reading its own `orders`
  assert.equal(renameTableIn('CREATE VIEW v AS select * from `shop`.`orders`', 'other', { db: 'shop', table: 'orders' }, 'sales').changes, 1);
  assert.equal(renameTableIn('CREATE VIEW v AS select * from `orders`', 'other', { db: 'shop', table: 'orders' }, 'sales').changes, 0);
});

test('table rename in routine bodies: strings and comments untouched, ambiguous names reported', () => {
  const body = `DELIMITER $$
CREATE PROCEDURE p_close(IN id INT)
BEGIN
  -- orders closed here
  UPDATE orders SET status = 'orders' WHERE orders.id = id;
  INSERT INTO log(msg) SELECT CONCAT('closed ', id) FROM orders o WHERE o.id = id;
  SELECT orders;
END$$
DELIMITER ;`;
  const r = renameTableIn(body, 'shop', { db: 'shop', table: 'orders' }, 'order');
  assert.equal(r.changes, 3);
  assert.match(r.text, /-- orders closed here/);
  assert.match(r.text, /UPDATE `order` SET status = 'orders' WHERE `order`\.id = id/); // reserved word quoted
  assert.match(r.text, /FROM `order` o/);
  assert.deepEqual(r.warnings.map((w) => w.line), [7]);
  assert.match(r.text, /SELECT orders;/);
});

test('trigger header and body', () => {
  const trg = "DELIMITER $$\nCREATE DEFINER=`root`@`localhost` TRIGGER `trg_qty` BEFORE UPDATE ON `orders` FOR EACH ROW BEGIN IF NEW.qty < 0 THEN SET NEW.qty = 0; END IF; INSERT INTO audit(t, v) VALUES ('orders', OLD.qty); END$$\nDELIMITER ;";
  let r = renameTableIn(trg, 'shop', { db: 'shop', table: 'orders' }, 'sales');
  assert.equal(r.changes, 1);
  assert.match(r.text, /ON `sales` FOR EACH ROW/);
  r = renameColumnIn(trg, 'shop', { db: 'shop', table: 'orders', column: 'qty' }, 'quantity', true);
  assert.equal(r.changes, 3);
  assert.match(r.text, /NEW\.quantity < 0 THEN SET NEW\.quantity = 0/);
  assert.match(r.text, /OLD\.quantity\)/);
});

test('column rename: qualified by alias, by table, by db.table; output aliases kept', () => {
  let r = renameColumnIn(MARIA_VIEW, 'shop', { db: 'shop', table: 'orders', column: 'qty' }, 'quantity');
  assert.equal(r.changes, 1);
  assert.match(r.text, /`o`\.`quantity` AS `qty`/);
  r = renameColumnIn(MARIA_VIEW, 'shop', { db: 'shop', table: 'orders', column: 'id' }, 'order_id');
  assert.equal(r.changes, 1); // `o`.`id`, not `c`.`id`
  assert.match(r.text, /`c`\.`id`\)/);
  r = renameColumnIn(MYSQL_VIEW, 'shop', { db: 'shop', table: 'orders', column: 'qty' }, 'quantity');
  assert.equal(r.changes, 1);
  assert.match(r.text, /sum\(`shop`\.`orders`\.`quantity`\) AS `qty`/);
});

test('column rename: unqualified names only in single-table statements', () => {
  const body = `CREATE PROCEDURE p() BEGIN
  UPDATE orders SET qty = qty + 1 WHERE id = 1;
  INSERT INTO orders (customer_id, qty) VALUES (1, 2);
  SELECT qty FROM orders JOIN items ON items.order_id = orders.id;
  SELECT qty FROM items;
END`;
  const r = renameColumnIn(body, 'shop', { db: 'shop', table: 'orders', column: 'qty' }, 'quantity');
  assert.equal(r.changes, 3);
  assert.match(r.text, /SET quantity = quantity \+ 1/);
  assert.match(r.text, /\(customer_id, quantity\)/);
  assert.deepEqual(r.warnings.map((w) => w.line), [4]);
  assert.match(r.text, /SELECT qty FROM items;/);
});

test('routine calls, tables used, rename statement', () => {
  assert.equal(routineCalls('BEGIN CALL p_close(1); SET x = shop.f_tot(2); SELECT p_close FROM t; END', 'shop', { db: 'shop', name: 'p_close' }), 1);
  assert.equal(routineCalls('SELECT shop.f_tot(2), f_tot(3)', 'shop', { db: 'shop', name: 'f_tot' }), 2);
  const known = [{ db: 'shop', name: 'orders' }, { db: 'shop', name: 'customers' }, { db: 'shop', name: 'items' }];
  assert.deepEqual(tablesUsed(MARIA_VIEW, 'shop', known).map((x) => x.name), ['orders', 'customers']);
  assert.equal(renameColumnStatement('shop', 'orders', 'qty', 'quantity', '10.11.6-MariaDB'), 'ALTER TABLE `shop`.`orders` RENAME COLUMN `qty` TO `quantity`');
  assert.equal(renameColumnStatement('shop', 'orders', 'qty', 'quantity', '10.4.32-MariaDB', 'int(11) NOT NULL DEFAULT 0'),
    'ALTER TABLE `shop`.`orders` CHANGE COLUMN `qty` `quantity` int(11) NOT NULL DEFAULT 0');
  assert.match(renameColumnStatement('shop', 'orders', 'qty', 'q', '8.4.3'), /RENAME COLUMN/);
});
