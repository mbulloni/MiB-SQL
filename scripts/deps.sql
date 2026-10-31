-- Test database for Dependencies / Rename (run as root: the objects need a definer whose code the app can read).
DROP DATABASE IF EXISTS mibsql_deps;
CREATE DATABASE mibsql_deps;
USE mibsql_deps;
CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(50));
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, qty INT NOT NULL DEFAULT 0, status VARCHAR(10),
  CONSTRAINT fk_ord_cust FOREIGN KEY (customer_id) REFERENCES customers(id));
CREATE TABLE items (id INT PRIMARY KEY, order_id INT, qty INT, CONSTRAINT fk_item_ord FOREIGN KEY (order_id) REFERENCES orders(id));
CREATE TABLE audit (id INT AUTO_INCREMENT PRIMARY KEY, msg VARCHAR(200));
INSERT INTO customers VALUES (1, 'Rossi'), (2, 'Bianchi');
INSERT INTO orders VALUES (10, 1, 5, 'open'), (11, 2, 3, 'open');
INSERT INTO items VALUES (100, 10, 2), (101, 11, 1);
CREATE VIEW v_orders AS SELECT o.id, o.qty, c.name AS customer FROM orders o JOIN customers c ON o.customer_id = c.id;
CREATE VIEW v_tot AS SELECT customer_id, SUM(qty) AS qty FROM orders GROUP BY customer_id;
DELIMITER $$
CREATE PROCEDURE p_close(IN pid INT)
BEGIN
  UPDATE orders SET status = 'closed', qty = qty WHERE id = pid;
  -- qty is ambiguous here (items has qty too): a rename of orders.qty reports it instead of changing it
  INSERT INTO audit(msg) SELECT CONCAT('closed ', qty) FROM orders o JOIN items i ON i.order_id = o.id WHERE o.id = pid;
END$$
CREATE FUNCTION f_tot(cid INT) RETURNS INT READS SQL DATA
BEGIN
  RETURN (SELECT SUM(qty) FROM orders WHERE customer_id = cid);
END$$
CREATE TRIGGER trg_qty BEFORE UPDATE ON orders FOR EACH ROW
BEGIN
  IF NEW.qty < 0 THEN SET NEW.qty = 0; END IF;
END$$
CREATE PROCEDURE p_report()
BEGIN
  SELECT f_tot(1);
  CALL p_close(10);
END$$
DELIMITER ;
CREATE EVENT ev_clean ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM orders WHERE qty = 0;
