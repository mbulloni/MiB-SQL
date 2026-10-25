// Word lists for the test data generator: Italian and English names, places and companies (fictitious).

export interface DataSet {
  first: string[];
  last: string[];
  cities: string[];
  streets: string[];
  countries: string[];
  companySuffix: string[];
  domains: string[];
  words: string[];
  phone: string; // pattern: # = digit
  zip: string;
}

export const DATA: Record<'it' | 'en', DataSet> = {
  it: {
    first: ['Marco', 'Giulia', 'Luca', 'Francesca', 'Alessandro', 'Chiara', 'Andrea', 'Sara', 'Matteo', 'Valentina', 'Lorenzo', 'Martina', 'Davide', 'Elena',
      'Simone', 'Federica', 'Paolo', 'Silvia', 'Stefano', 'Laura', 'Giorgio', 'Anna', 'Roberto', 'Alessia', 'Fabio', 'Elisa', 'Riccardo', 'Giorgia', 'Nicola',
      'Beatrice', 'Tommaso', 'Camilla', 'Gabriele', 'Sofia', 'Emanuele', 'Aurora', 'Michele', 'Ilaria', 'Pietro', 'Marta'],
    last: ['Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca', 'Mancini',
      'Costa', 'Giordano', 'Rizzo', 'Lombardi', 'Moretti', 'Barbieri', 'Fontana', 'Santoro', 'Mariani', 'Rinaldi', 'Caruso', 'Ferrara', 'Galli', 'Martini',
      'Leone', 'Longo', 'Gentile', 'Martinelli', 'Vitale', 'Lombardo', 'Serra', 'Coppola', 'De Santis', 'D\'Angelo', 'Marchetti'],
    cities: ['Roma', 'Milano', 'Napoli', 'Torino', 'Palermo', 'Genova', 'Bologna', 'Firenze', 'Bari', 'Catania', 'Venezia', 'Verona', 'Messina', 'Padova',
      'Trieste', 'Brescia', 'Parma', 'Prato', 'Taranto', 'Modena', 'Reggio Calabria', 'Perugia', 'Livorno', 'Ravenna', 'Cagliari', 'Foggia', 'Rimini',
      'Salerno', 'Ferrara', 'Sassari', 'Latina', 'Monza', 'Siracusa', 'Pescara', 'Bergamo', 'Trento', 'Vicenza', 'Bolzano', 'Ancona', 'Lecce'],
    streets: ['Via Roma', 'Via Garibaldi', 'Via Mazzini', 'Corso Italia', 'Via Dante', 'Via Verdi', 'Via Cavour', 'Viale Europa', 'Via Marconi', 'Piazza della Repubblica',
      'Via Manzoni', 'Via Leopardi', 'Via XX Settembre', 'Corso Vittorio Emanuele', 'Via San Francesco', 'Via dei Mille', 'Via Matteotti', 'Via Carducci', 'Via Gramsci', 'Via Pascoli'],
    countries: ['Italia', 'Francia', 'Germania', 'Spagna', 'Svizzera', 'Austria', 'Portogallo', 'Belgio', 'Paesi Bassi', 'Regno Unito', 'Grecia', 'Polonia', 'Svezia', 'Irlanda', 'Croazia'],
    companySuffix: ['S.r.l.', 'S.p.A.', 'S.n.c.', 'S.a.s.', '& Figli', 'Group', 'Italia'],
    domains: ['example.com', 'example.org', 'example.net', 'esempio.it', 'test.example'],
    words: ['alfa', 'blu', 'casa', 'dato', 'elenco', 'fiume', 'giorno', 'idea', 'lago', 'mare', 'nota', 'ordine', 'prova', 'quadro', 'rete', 'sole', 'tempo',
      'valore', 'zona', 'libro', 'porta', 'strada', 'campo', 'vento', 'luce', 'parola', 'numero', 'piano', 'punto', 'gruppo', 'modello', 'servizio', 'cliente',
      'prodotto', 'progetto', 'rapido', 'nuovo', 'grande', 'piccolo', 'verde', 'rosso', 'chiaro', 'semplice', 'utile', 'finale', 'primo', 'ultimo', 'breve'],
    phone: '+39 3## ### ####',
    zip: '#####',
  },
  en: {
    first: ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan',
      'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Daniel', 'Nancy', 'Matthew', 'Lisa', 'Anthony', 'Betty', 'Mark', 'Emily', 'Paul', 'Emma',
      'Steven', 'Olivia', 'Andrew', 'Sophia', 'Joshua', 'Grace', 'Kevin', 'Chloe', 'Brian', 'Amelia'],
    last: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin',
      'Lee', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Hill', 'Green', 'Adams',
      'Baker', 'Nelson', 'Carter', 'Mitchell', 'Roberts', 'Turner', 'Phillips', 'Campbell', 'O\'Brien'],
    cities: ['London', 'New York', 'Manchester', 'Chicago', 'Dublin', 'Boston', 'Toronto', 'Sydney', 'Seattle', 'Edinburgh', 'Denver', 'Austin', 'Bristol',
      'Leeds', 'Portland', 'Vancouver', 'Melbourne', 'Glasgow', 'Atlanta', 'Phoenix', 'Liverpool', 'Auckland', 'Cardiff', 'Ottawa', 'Dallas', 'Miami',
      'Oxford', 'Cambridge', 'Belfast', 'Brighton'],
    streets: ['Main Street', 'High Street', 'Oak Avenue', 'Maple Road', 'Park Lane', 'Church Street', 'Elm Street', 'Station Road', 'Victoria Road', 'Mill Lane',
      'Cedar Drive', 'King Street', 'Queen Street', 'Bridge Road', 'River View', 'Pine Street', 'Lake Drive', 'Hillside Avenue', 'Green Lane', 'Market Street'],
    countries: ['United Kingdom', 'United States', 'Canada', 'Ireland', 'Australia', 'New Zealand', 'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Japan'],
    companySuffix: ['Ltd', 'Inc.', 'LLC', 'Group', '& Co.', 'Holdings', 'Partners'],
    domains: ['example.com', 'example.org', 'example.net', 'test.example', 'mail.example'],
    words: ['alpha', 'blue', 'home', 'data', 'list', 'river', 'day', 'idea', 'lake', 'sea', 'note', 'order', 'test', 'frame', 'network', 'sun', 'time',
      'value', 'zone', 'book', 'door', 'road', 'field', 'wind', 'light', 'word', 'number', 'plan', 'point', 'group', 'model', 'service', 'customer',
      'product', 'project', 'quick', 'new', 'large', 'small', 'green', 'red', 'clear', 'simple', 'useful', 'final', 'first', 'last', 'short'],
    phone: '+1 (###) ###-####',
    zip: '#####',
  },
};
